"""Release idle inference objects without touching media or recognition records."""
import ctypes
import gc
import os
import sys
import time

from fastapi import HTTPException
from sqlmodel import select

from app.concurrency import heavy_writer
from app.models import ProcessingTask
from app.tasks.recognition_activity import submission_lock


def process_memory():
    if os.name != 'nt': return {'working_set_bytes':None,'private_bytes':None}
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('page_faults',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in (
            'peak_working_set','working_set','quota_peak_paged','quota_paged','quota_peak_nonpaged','quota_nonpaged','pagefile','peak_pagefile','private')]
    try:
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=ctypes.c_void_p
        psapi=ctypes.WinDLL('psapi',use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes=[ctypes.c_void_p,ctypes.POINTER(Counters),wintypes.DWORD]
        counters=Counters();counters.cb=ctypes.sizeof(counters)
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(counters),counters.cb):
            return {'working_set_bytes':counters.working_set,'private_bytes':counters.private}
    except (OSError,AttributeError): pass
    return {'working_set_bytes':None,'private_bytes':None}


def trim_working_set():
    """Return unused Windows resident pages after inference objects are freed."""
    if os.name != 'nt': return False
    try:
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=ctypes.c_void_p
        psapi=ctypes.WinDLL('psapi',use_last_error=True)
        psapi.EmptyWorkingSet.argtypes=[ctypes.c_void_p]
        return bool(psapi.EmptyWorkingSet(kernel.GetCurrentProcess()))
    except (OSError,AttributeError): return False


def status(session):
    from app.processor_registry import processors
    loaded=[processor.name for processor in processors if getattr(processor,'model',None) is not None or getattr(processor,'_clip',None) is not None]
    clip=sys.modules.get('app.clip_onnx')
    if clip and getattr(clip,'_clip_encoder',None) is not None:loaded.append('clip')
    active=session.exec(select(ProcessingTask.id).where(ProcessingTask.status.in_(['pending','running']))).first()
    return {'loaded_models':sorted(set(loaded)),'busy':active is not None,'automatic_face_unload':True,**process_memory()}


def release_idle_models(session):
    with submission_lock:
        if status(session)['busy']: raise HTTPException(409,'任务正在处理或排队，结束后会自动卸载人脸模型；请空闲后再手动释放。')
        deadline=time.monotonic()+2
        with heavy_writer(name='release-idle-models',cancelled=lambda:time.monotonic()>deadline) as acquired:
            if not acquired: raise HTTPException(409,'后台尚未空闲，请稍后重试。')
            session.expire_all()
            before=status(session)
            if before['busy']: raise HTTPException(409,'有新任务加入，请等待任务结束。')
            from app.processor_registry import processors
            for processor in processors:
                processor.unload()
            clip=sys.modules.get('app.clip_onnx')
            if clip:clip.reset_clip_encoder()
            gc.collect()
            trimmed=trim_working_set()
            return {'before':before,'after':status(session),'working_set_trimmed':trimmed,'recognition_data_modified':False}
