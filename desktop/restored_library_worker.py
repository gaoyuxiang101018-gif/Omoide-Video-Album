"""Import only successful output records; never start scan or face tasks."""
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
from storage_paths import cache_dir, install_dir
import socket
import sqlite3
import time
import urllib.request

API='http://127.0.0.1:8123'
CACHE=cache_dir()

def request(path,body=None):
    payload=json.dumps(body,ensure_ascii=False).encode('utf8') if body is not None else None
    req=urllib.request.Request(API+path,data=payload,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=120 if payload else 10) as response:
        return json.load(response)

def pending_outputs(profile):
    key=hashlib.sha256(str(Path(profile).resolve()).lower().encode()).hexdigest()[:20]
    database=CACHE/'film'/key/'film.sqlite3'
    if not database.is_file():return []
    connection=sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
    try:
        return connection.execute("SELECT job_id,item_index,output_size,output_mtime_ns FROM export_items WHERE status='succeeded' ORDER BY updated_at").fetchall()
    finally:connection.close()

def save_status(status):
    temporary=CACHE/f'restore-import-status.{os.getpid()}.tmp'
    temporary.write_text(json.dumps({**status,'updated_at':time.time()},ensure_ascii=False),'utf8')
    temporary.replace(CACHE/'restore-import-status.json')

def main():
    guard=socket.socket()
    if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):guard.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
    try:guard.bind(('127.0.0.1',18126))
    except OSError:return
    CACHE.mkdir(parents=True,exist_ok=True)
    logging.basicConfig(handlers=[RotatingFileHandler(CACHE/'restore-import.log',maxBytes=1000000,backupCount=2,encoding='utf8')],level=logging.INFO)
    handled=set();retry_at={};last_seen=time.monotonic();imported=0
    try:
        while True:
            delay=5
            try:
                config=request('/api/config/')
                last_seen=time.monotonic();profile=config['general']['data_dir']
                links=request('/api/media/restored-links')
                if os.path.normcase(str(Path(links['data_dir']).resolve()))!=os.path.normcase(str(Path(profile).resolve())):
                    raise ValueError('资料库正在切换，稍后重试。')
                known={(row['job_id'],row['item_index'],row['output_size'],row['output_mtime_ns']) for row in links['items']}
                candidates=[row for row in pending_outputs(profile) if row not in known and (profile,*row) not in handled and retry_at.get((profile,*row),0)<=time.monotonic()]
                state={'data_dir':profile,'pending':len(candidates),'running':False,'imported':imported,'error':''}
                if candidates:
                    row=candidates[0];state['running']=True;save_status(state)
                    result=request('/api/media/sync-restored',{'profile_path':profile,'items':[{'job_id':row[0],'item_index':row[1]}]})['items'][0]
                    state['running']=False
                    if result['status'] in ('imported','existing'):
                        handled.add((profile,*row));imported+=result['status']=='imported'
                        state['imported']=imported;state['pending']-=1;delay=.1
                        logging.info('Restored media registered: media_id=%s job=%s item=%s',result['media_id'],row[0],row[1])
                    else:
                        state['error']=result.get('error','成片暂未入库，稍后自动重试。')
                        retry_at[(profile,*row)]=time.monotonic()+30
                        logging.warning('Restored import delayed: %s',state['error'])
                save_status(state)
            except Exception as error:
                logging.warning('Restored import waiting: %s',error)
                if time.monotonic()-last_seen>60:return
            time.sleep(delay)
    finally:guard.close()

if __name__=='__main__':main()
