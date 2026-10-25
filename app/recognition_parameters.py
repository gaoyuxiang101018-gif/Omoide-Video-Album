"""Describe effective settings without constructing or loading an inference model."""
from datetime import datetime, timezone
from pathlib import Path
import re
import sys

from app.config import settings
from app.person_views import state


def overview(session):
    from app.frames import PROCESSING_MAX_DIM, FRAME_EXTRACT_MAX_PROCESSES, FRAME_EXTRACT_DECODER_THREADS
    from app.model_memory import status
    from app.processor_registry import processors
    face = settings.face_recognition
    detector = getattr(face.face_detection_model, 'value', face.face_detection_model)
    models = settings.general.models_dir / 'models'
    current = next((p for p in processors if p.name == 'faces' and getattr(p, 'model', None) is not None), None)
    runtime = []
    if current is not None:
        for task, model in current.model.models.items():
            model_session = getattr(model, 'session', None)
            runtime.append({'task': task, 'file': Path(getattr(model, 'model_file', '')).name,
                            'providers': model_session.get_providers() if model_session else [],
                            'det_threshold': getattr(model, 'det_thresh', None),
                            'input_size': list(getattr(model, 'input_size', ()) or ())})
    last = None
    if not runtime:
        log = settings.general.data_dir / 'logs' / 'omoide.log'
        try:
            with log.open('rb') as stream:
                stream.seek(0, 2); size = stream.tell(); stream.seek(max(0, size-512*1024))
                matches = re.findall(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[^\n]*?)FaceProcessor: using (\w+) detector on (\w+)', stream.read().decode('utf8', errors='replace'))
            if matches:
                at, pack, provider = matches[-1]; last = {'logged_at': at[:23], 'detector': pack, 'provider': provider}
        except OSError:
            pass
    binary = bool(settings.general.is_binary)
    groups = []
    def group(name, entries):
        groups.append({'name': name, 'items': [{'key': key, 'label': label, 'value': value, 'status': active, 'description': explanation}
                                              for key, label, value, active, explanation in entries]})
    group('检测与识别', [
        ('recognizer','身份识别模型','buffalo_l / w600k_r50.onnx','生效','身份特征模型固定使用buffalo_l；切换检测器不会更换身份特征模型。'),
        ('detector','人脸检测模型',str(detector),'配置','buffalo_l使用det_10g.onnx；buffalo_s仅换用det_500m.onnx。切换配置在下次加载时生效，当前会话文件见上方。'),
        ('det_size','检测输入','640 × 640','生效','模型准备时的检测尺寸。'),
        ('processing_dim','处理画面最长边',PROCESSING_MAX_DIM,'生效','保留宽高比，较小画面不放大；人脸坐标对应处理画面。'),
        ('det_confidence','最低检测置信度',face.face_recognition_min_confidence,'生效','判断图中是否有人脸，不等同于判断两张脸是否为同一个人。'),
        ('min_pixels','最低人脸裁剪面积',face.face_recognition_min_face_pixels,'生效','裁剪图像面积，单位为像素；1600像素约为40×40。'),
        ('sharpness','模糊过滤阈值',face.face_sharpness_min_variance,'生效' if face.face_sharpness_filter_enabled else '关闭','关闭时此阈值不参与筛选。'),
        ('augmentation','识别增强','BGR颜色输入＋镜像特征融合','生效','检测使用5点对齐，大脸或未检出时追加留边检测。'),
        ('prefer_gpu','优先使用GPU',settings.processors.prefer_gpu,'配置偏好','实际执行后端以当前模型会话为准；初始化失败可退回CPU。'),
    ])
    group('视频采样与资源', [
        ('scene','自动场景检测',settings.video.auto_scene_detection,'生效','关闭时使用均匀时间采样；开启时取场景采样。'),
        ('max_frames','每个视频画面上限',settings.video.max_frames_per_video,'生效','均匀采样间隔=max(2秒,视频时长÷此上限)，并照顾片尾。'),
        ('face_cap','检测阶段再次缩减帧数',face.face_detection_max_video_frames,'生效','0表示检测全部已采样画面；非0时才会再均匀缩减。'),
        ('scene_skip','场景检测跳帧',settings.video.scene_detection_frame_skip,'生效' if settings.video.auto_scene_detection else '备用','这是场景检测跳帧，不能解释成每2秒取一帧。'),
        ('decode_processes','常规取帧最大并行进程',FRAME_EXTRACT_MAX_PROCESSES,'生效','局部精查使用单个可取消的取帧进程。'),
        ('decode_threads','常规取帧解码线程',FRAME_EXTRACT_DECODER_THREADS,'生效','每个取帧进程的解码线程数。'),
        ('unload','任务结束自动卸载人脸模型',True,'生效','查看本页不会加载模型；任务执行时仍需保留模型。'),
    ])
    group('人物匹配与归类', [
        ('algorithm','当前人物聚类算法','Chinese Whispers' if binary else 'HDBSCAN','生效','当前桌面打包程序使用Chinese Whispers。'),
        ('attach','归入已有人物相似度',face.existing_person_cosine_threshold,'生效','越高越保守，可能留下更多待确认人脸。'),
        ('margin','第一与第二人选分差',face.existing_person_min_cosine_margin,'生效','分差不足时保留待确认，避免两个相似人物之间误归类。'),
        ('merge','人物自动合并相似度(%)',face.person_merge_percent_similarity,'生效','明确标记为不同的人物优先于相似度；限制随合法合并继承。'),
        ('min_face','建新人最低人脸次数',face.person_min_face_count,'生效','用于自动创建人物。'),
        ('min_media','建新人最低媒体数量',face.person_min_media_count,'生效','跨视频/照片数量要求，和人脸次数不同。'),
        ('radius','聚类最大L2半径',face.person_cluster_max_l2_radius,'生效','清除簇中偏离中心的异常脸。'),
        ('prototypes','每个人物最多原型',face.person_matching_max_prototypes,'生效','用于兼顾正脸、侧脸等不同姿态。'),
        ('cluster_batch','人物聚类批大小',face.cluster_batch_size,'生效','每批用于归类的人脸数量上限。'),
        ('merge_k','自动合并搜索近邻数',face.person_merge_search_k,'生效','每个人物参与比较的候选数量。'),
        ('rerun_iou','同帧重复框IoU阈值',face.rerun_face_iou_dedupe_threshold,'生效','局部补查只有在同一采样时刻且框重合超过阈值时才跳过。'),
        ('seed_conf','新人物种子检测置信度',face.cluster_seed_min_det_score,'生效','质量不足的脸不作为新簇种子，仍可尝试匹配已有人物。'),
        ('seed_pose','有效建组最低正脸度',max(.65,face.cluster_seed_min_frontality,face.person_frontal_anchor_min_frontality),'生效','必须有姿态和置信度评分；侧脸及姿态未知仅尝试归附，不单独建人物。'),
        ('frontal_policy','正脸与侧脸规则','正脸建组，侧脸归附；不确定则待确认','生效','只把有可靠正脸参考的人物作为自动匹配和自动合并目标。'),
    ])
    cw = [('cw_threshold','CW连边余弦阈值',face.cw_threshold),('cw_iterations','CW迭代次数',face.cw_iterations),
          ('cw_k_neighbors','CW近邻数',face.cw_k_neighbors),('cw_min_member_similarity','CW成员最低相似度',face.cw_min_member_similarity)]
    hdb_labels = {'hdbscan_min_cluster_size':'HDBSCAN最小簇大小','hdbscan_min_samples':'HDBSCAN最小样本数',
                  'hdbscan_cluster_selection_method':'HDBSCAN簇选择方式','hdbscan_cluster_selection_epsilon':'HDBSCAN簇选择距离',
                  'hdbscan_min_membership_probability':'HDBSCAN最低成员概率'}
    group('算法细节', [(key,label,value,'生效' if binary else '备用','仅在Chinese Whispers下使用。') for key,label,value in cw] +
          [(key,hdb_labels.get(key,key),value,'备用' if binary else '生效','仅在HDBSCAN下使用，当前生效算法见上。') for key,value in face.model_dump(mode='json').items() if key.startswith('hdbscan_')])
    files = []
    for pack, name in [('buffalo_l','w600k_r50.onnx'), (str(detector),'det_10g.onnx' if detector=='buffalo_l' else 'det_500m.onnx')]:
        file = models / pack / name
        try: size = file.stat().st_size
        except OSError: size = None
        files.append({'file': name, 'exists': size is not None, 'size': size, 'path': str(file)})
    return {**state(session), 'generated_at': datetime.now(timezone.utc).isoformat(), 'groups': groups,
            'runtime_models': runtime, 'last_runtime': last, 'memory': status(session), 'model_files': files,
            'storage': {'资料库': str(settings.general.data_dir), '模型': str(settings.general.models_dir),
                        '显示缓存': str(settings.general.omoide_dir / 'view-cache'), '缩略图': str(settings.general.thumb_dir)},
            'sampling': {'uniform': not settings.video.auto_scene_detection, 'min_interval': 2, 'max_frames': max(1,int(settings.video.max_frames_per_video))},
            'raw_face_settings': face.model_dump(mode='json')}
