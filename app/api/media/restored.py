from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from app.config import settings
from app.media_paths import path_key
from app.presentation import ensure_writable
from app.restored_media import import_output, list_links

router = APIRouter()

class RestoreItem(BaseModel):
    job_id: str = Field(min_length=1,max_length=100)
    item_index: int = Field(ge=0)

class SyncRequest(BaseModel):
    profile_path: str
    items: list[RestoreItem] = Field(min_length=1,max_length=10)

@router.get('/restored-links',dependencies=[Depends(ensure_writable)])
def restored_links():
    return list_links()

@router.post('/sync-restored',dependencies=[Depends(ensure_writable)])
def sync_restored(request: SyncRequest):
    if path_key(Path(request.profile_path).resolve()) != path_key(Path(settings.general.data_dir).resolve()):
        raise HTTPException(409,'资料库已切换，请重试。')
    result=[]
    for item in request.items:
        try:
            result.append({'job_id':item.job_id,'item_index':item.item_index,**import_output(item.job_id,item.item_index)})
        except (OSError,ValueError,RuntimeError) as error:
            result.append({'job_id':item.job_id,'item_index':item.item_index,'status':'error','error':str(error)})
    return {'items':result,'face_processing_started':False}
