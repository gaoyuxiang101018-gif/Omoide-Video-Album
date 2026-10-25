"""Windows job-object CPU budget, scoped to the installed Omoide process tree."""
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import threading

MODES = {'light': 25, 'balanced': 50, 'full': 100}

class CpuRate(ctypes.Structure):
    _fields_ = [('ControlFlags', wintypes.DWORD), ('CpuRate', wintypes.DWORD)]

class ProcessEntry(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG), ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]

class WindowsCpuJob:
    def __init__(self, name):
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        k = self.kernel
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            'OpenProcess': ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            'CloseHandle': ([wintypes.HANDLE], wintypes.BOOL),
            'SetInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
            'QueryInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
            'AssignProcessToJobObject': ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            'IsProcessInJob': ([wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL),
            'SetPriorityClass': ([wintypes.HANDLE, wintypes.DWORD], wintypes.BOOL),
            'QueryFullProcessImageNameW': ([wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            'CreateToolhelp32Snapshot': ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            'Process32FirstW': ([wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
            'Process32NextW': ([wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
        }
        for function, (args, result) in signatures.items():
            getattr(k, function).argtypes = args
            getattr(k, function).restype = result
        self.handle = k.CreateJobObjectW(None, name)
        if not self.handle: raise ctypes.WinError(ctypes.get_last_error())
        # No memory limits, termination limits, or KILL_ON_JOB_CLOSE flag.

    def set_percent(self, percent):
        if not 1 <= percent <= 100: raise ValueError('Invalid CPU limit')
        info = CpuRate(0x1 | 0x4, percent * 100)
        if not self.kernel.SetInformationJobObject(self.handle, 15, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        verified = CpuRate()
        if not self.kernel.QueryInformationJobObject(self.handle, 15, ctypes.byref(verified), ctypes.sizeof(verified), None):
            raise ctypes.WinError(ctypes.get_last_error())
        if verified.CpuRate != percent * 100 or verified.ControlFlags & 5 != 5:
            raise RuntimeError('CPU limit verification failed')
        return verified.CpuRate // 100

    def processes(self):
        snapshot = self.kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = ProcessEntry(); entry.dwSize = ctypes.sizeof(entry)
            valid = self.kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            result = []
            while valid:
                result.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
                valid = self.kernel.Process32NextW(snapshot, ctypes.byref(entry))
            return result
        finally: self.kernel.CloseHandle(snapshot)

    def open_process(self, pid):
        process = self.kernel.OpenProcess(0x1000 | 0x0100 | 0x0200 | 0x0001, False, pid)
        if not process: raise ctypes.WinError(ctypes.get_last_error())
        return process

    def image_path(self, process):
        buffer = ctypes.create_unicode_buffer(32768); length = wintypes.DWORD(len(buffer))
        if not self.kernel.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(length)):
            raise ctypes.WinError(ctypes.get_last_error())
        return Path(buffer.value)

    def attach_handle(self, process, percent):
        assigned = wintypes.BOOL()
        if not self.kernel.IsProcessInJob(process, self.handle, ctypes.byref(assigned)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not assigned.value and not self.kernel.AssignProcessToJobObject(self.handle, process):
            raise ctypes.WinError(ctypes.get_last_error())
        if not self.kernel.SetPriorityClass(process, 0x20 if percent == 100 else 0x4000):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            try: self.set_percent(100)
            finally:
                self.kernel.CloseHandle(self.handle)
                self.handle = None

class ResourceController:
    def __init__(self, install, cache):
        self.target = (install / 'omoide-0.7.5-cpu/omoide-0.7.5-cpu.exe').resolve()
        self.settings_file = cache / 'resource-settings.json'
        self.lock = threading.RLock()
        try: self.mode = json.loads(self.settings_file.read_text('utf8'))['mode']
        except (OSError, ValueError, KeyError): self.mode = 'balanced'
        if self.mode not in MODES: self.mode = 'balanced'
        digest = hashlib.sha256(str(self.target).lower().encode()).hexdigest()[:16]
        self.job = WindowsCpuJob('Local\\OmoideCpuBudget-' + digest)
        self.last = {'mode': self.mode, 'cpu_percent': MODES[self.mode], 'applied': False}

    def apply(self):
        with self.lock:
            percent = MODES[self.mode]
            result = {'mode': self.mode, 'cpu_percent': percent, 'applied': False, 'gpu_parallel_tasks': 1, 'gpu_percent_hard_limit': False}
            try:
                result['verified_cpu_percent'] = self.job.set_percent(percent)
                entries = self.job.processes()
                parents = []
                for pid, _, name in entries:
                    if name.lower() != self.target.name.lower(): continue
                    process = self.job.open_process(pid)
                    try:
                        if str(self.job.image_path(process)).lower() != str(self.target).lower(): continue
                        self.job.attach_handle(process, percent); parents.append(pid)
                    finally: self.job.kernel.CloseHandle(process)
                # Already-running decoder children predate the job assignment.
                for pid, parent, name in entries:
                    if parent in parents and name.lower().startswith('ffmpeg'):
                        try:
                            process = self.job.open_process(pid)
                            try: self.job.attach_handle(process, percent)
                            finally: self.job.kernel.CloseHandle(process)
                        except OSError: pass  # The short-lived decoder may have exited.
                result['applied'] = bool(parents)
                result['process_ids'] = parents
                if not parents: result['error'] = '识别程序尚未启动'
            except Exception as error:
                result['error'] = str(error)
            self.last = result
            return dict(result)

    def set_mode(self, mode):
        if mode not in MODES: raise ValueError('Unknown resource mode')
        with self.lock:
            self.mode = mode
            temporary = self.settings_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'mode': mode}), 'utf8'); temporary.replace(self.settings_file)
            return self.apply()

    def close(self): self.job.close()
