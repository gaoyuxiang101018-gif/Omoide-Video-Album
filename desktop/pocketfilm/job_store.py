"""Durable, local-only export queue and history.

Each operation opens its own SQLite connection and commits atomically. The
database may also contain LibraryStore's tables. Source and output media are
never modified. A worker's temporary item indices must be mapped back to the
stable indices returned by ``runnable_files`` before recording events.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


ITEM_STATES = frozenset({"queued", "running", "paused", "succeeded", "failed"})
JOB_STATES = frozenset({"queued", "running", "paused", "completed", "failed"})
ACTIVE_STATES = ("queued", "running", "paused")
_PROFILES = {"DLog": "dlog", "DLog2": "dlog2", "HDR_HLG": "hlg",
             "Normal10": "rec709", "Normal8": "rec709"}


def _path_key(path):
    return os.path.normcase(os.path.abspath(os.path.expanduser(os.fspath(path))))


def _encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      default=lambda obj: os.fspath(obj) if isinstance(obj, os.PathLike)
                      else _unsupported(obj))


def _unsupported(value):
    raise TypeError(f"Unsupported queue value: {type(value).__name__}")


def _signature(video):
    if not isinstance(video, dict) or not video.get("path"):
        raise ValueError("视频路径不能为空。")
    path = _path_key(video["path"])
    size, modified = video.get("size"), video.get("mtime_ns")
    if size is None or modified is None:
        stat = Path(path).stat()
        size = stat.st_size if size is None else size
        modified = stat.st_mtime_ns if modified is None else modified
    profile = video.get("manual_profile") or _PROFILES.get(video.get("category"), "")
    return path, int(size), int(modified), str(profile)


def _file_stat(path):
    try:
        file = Path(path)
        stat = file.stat()
        if file.is_file() and stat.st_size > 0:
            return stat.st_size, stat.st_mtime_ns
    except (OSError, ValueError):
        pass
    return None, None


class JobStore:
    """Thread-safe through independent connections, with no long-lived handles.

    ``jobs`` lists visible jobs oldest first. Removing a nonrunning job hides it
    from the queue while keeping its successful exports available in history.
    ``recover_interrupted`` is a startup operation; do not call it while another
    instance is intentionally exporting to this same database.
    """

    def __init__(self, db_path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS export_jobs (
                    id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    output_dir TEXT NOT NULL,
                    output_key TEXT NOT NULL,
                    files_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    error TEXT NOT NULL DEFAULT '',
                    removed INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS export_items (
                    job_id TEXT NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
                    item_index INTEGER NOT NULL,
                    video_json TEXT NOT NULL,
                    source_key TEXT NOT NULL,
                    source_size INTEGER NOT NULL,
                    source_mtime_ns INTEGER NOT NULL,
                    profile TEXT NOT NULL,
                    status TEXT NOT NULL,
                    output TEXT NOT NULL DEFAULT '',
                    output_size INTEGER,
                    output_mtime_ns INTEGER,
                    error TEXT NOT NULL DEFAULT '',
                    snapshot_json TEXT,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY(job_id,item_index)
                );
                CREATE INDEX IF NOT EXISTS export_items_source
                    ON export_items(source_key,source_size,source_mtime_ns,profile);
                CREATE INDEX IF NOT EXISTS export_jobs_queue
                    ON export_jobs(removed,status,created_at);
            """)

    @contextmanager
    def _connection(self, write=False):
        db = sqlite3.connect(str(self.path), timeout=10.0)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA synchronous=FULL")
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def close(self):
        """Compatibility convenience: no connection is retained between calls."""

    @staticmethod
    def _valid_output(item):
        if item["status"] != "succeeded" or not item["output"]:
            return False
        size, modified = _file_stat(item["output"])
        return (size is not None and size == item["output_size"]
                and modified == item["output_mtime_ns"])

    def _job(self, db, job_id):
        row = db.execute("SELECT * FROM export_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        job = dict(row)
        job["files"] = json.loads(job.pop("files_json"))
        job.pop("output_key")
        job["removed"] = bool(job["removed"])
        job["items"] = []
        counts = dict.fromkeys(sorted(ITEM_STATES), 0)
        for row in db.execute("SELECT * FROM export_items WHERE job_id=? ORDER BY item_index", (job_id,)):
            item = dict(row)
            item["index"] = item.pop("item_index")
            item["video"] = json.loads(item.pop("video_json"))
            encoded = item.pop("snapshot_json")
            item["source_snapshot"] = json.loads(encoded) if encoded else None
            item["output_exists"] = self._valid_output(item)
            counts[item["status"]] += 1
            job["items"].append(item)
        job["counts"] = counts
        job["total"] = len(job["items"])
        return job

    def get_job(self, job_id):
        with self._connection() as db:
            db.execute("BEGIN")
            return self._job(db, job_id)

    def jobs(self, status=None):
        if status is not None and status not in JOB_STATES:
            raise ValueError("Unknown job status")
        with self._connection() as db:
            db.execute("BEGIN")
            query = "SELECT id FROM export_jobs WHERE removed=0"
            args = ()
            if status is not None:
                query += " AND status=?"
                args = (status,)
            rows = db.execute(query + " ORDER BY created_at,rowid", args).fetchall()
            return [self._job(db, row["id"]) for row in rows]

    def enqueue(self, files, output_dir, mode):
        """Enqueue new items, deduplicating matching active work atomically.

        Return metadata ``added_count``, ``already_queued`` (input indices), and
        ``existing_job_ids``. When every input is already active, the earliest
        matching job is returned with added_count=0 instead of creating a job.
        """
        if not isinstance(files, list) or not files:
            raise ValueError("请先选择需要导出的视频。")
        if mode not in {"sdr", "hlg"}:
            raise ValueError("Unknown output mode")
        if not str(output_dir).strip():
            raise ValueError("导出目录不能为空。")
        encoded = _encode(files)
        raw_files = json.loads(encoded)
        prepared = [(index, video, _signature(video)) for index, video in enumerate(raw_files)]
        destination = os.path.abspath(os.path.expanduser(os.fspath(output_dir)))
        output_key = _path_key(destination)
        now = time.time()
        with self._connection(write=True) as db:
            active = db.execute("""
                SELECT i.source_key,i.source_size,i.source_mtime_ns,i.profile,i.job_id
                FROM export_items i JOIN export_jobs j ON j.id=i.job_id
                WHERE j.removed=0 AND j.status IN ('queued','running','paused')
                  AND i.status IN ('queued','running','paused')
                  AND j.mode=? AND j.output_key=? ORDER BY j.created_at,j.rowid
            """, (mode, output_key)).fetchall()
            active_by_key = {tuple(row)[:4]: row["job_id"] for row in reversed(active)}
            seen_paths, accepted, duplicates, existing = {}, [], [], []
            for index, video, signature in prepared:
                prior = seen_paths.get(signature[0])
                if prior is not None and prior != signature:
                    raise ValueError("同一原片包含不同的扫描信息或颜色模式，请重新选择。")
                if signature in active_by_key:
                    duplicates.append(index)
                    identifier = active_by_key[signature]
                    if identifier not in existing:
                        existing.append(identifier)
                elif prior is not None:
                    duplicates.append(index)
                else:
                    accepted.append((index, video, signature))
                seen_paths[signature[0]] = signature
            if not accepted:
                job = self._job(db, existing[0])
            else:
                identifier = uuid.uuid4().hex
                db.execute("""INSERT INTO export_jobs
                    (id,mode,output_dir,output_key,files_json,status,created_at,updated_at)
                    VALUES(?,?,?,?,?,'queued',?,?)""",
                           (identifier, mode, destination, output_key, encoded, now, now))
                for index, video, signature in accepted:
                    db.execute("""INSERT INTO export_items
                        (job_id,item_index,video_json,source_key,source_size,source_mtime_ns,
                         profile,status,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?)""",
                               (identifier, index, _encode(video), *signature, now))
                job = self._job(db, identifier)
            job.update(added_count=len(accepted), already_queued=duplicates, existing_job_ids=existing)
            return job

    def pending_job(self):
        with self._connection() as db:
            db.execute("BEGIN")
            row = db.execute("""SELECT id FROM export_jobs WHERE removed=0 AND status='queued'
                ORDER BY created_at,rowid LIMIT 1""").fetchone()
            return self._job(db, row["id"]) if row else None

    def runnable_files(self, job_id):
        job = self.get_job(job_id)
        if job["removed"] or job["status"] in {"completed", "failed"}:
            return []
        states = {"queued", "paused"} if job["status"] == "paused" else {"queued"}
        return [(item["index"], item["video"]) for item in job["items"] if item["status"] in states]

    @staticmethod
    def _editable(job):
        if job["removed"]:
            raise ValueError("任务已从队列移除。")

    def mark_job_running(self, job_id):
        with self._connection(write=True) as db:
            job = self._job(db, job_id)
            self._editable(job)
            if job["status"] not in {"queued", "running"}:
                raise ValueError("请先继续或重试此任务。")
            other = db.execute("SELECT id FROM export_jobs WHERE status='running' AND removed=0 AND id<>?",
                               (job_id,)).fetchone()
            if other:
                raise ValueError("已有还原任务正在运行。")
            db.execute("UPDATE export_jobs SET status='running',error='',updated_at=? WHERE id=?",
                       (time.time(), job_id))
            return self._job(db, job_id)

    def mark_item(self, job_id, index, status, output="", error="", source_snapshot=None):
        if status not in ITEM_STATES:
            raise ValueError("Unknown item status")
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("Item index must be an integer")
        if status == "succeeded" and not output:
            raise ValueError("完成记录缺少导出文件路径。")
        snapshot = _encode(source_snapshot) if source_snapshot is not None else None
        with self._connection(write=True) as db:
            job = self._job(db, job_id)
            self._editable(job)
            item = next((item for item in job["items"] if item["index"] == index), None)
            if item is None:
                raise KeyError((job_id, index))
            # Completed callbacks may be replayed at worker completion. A later
            # failed/cancelled event must never erase an already committed result.
            if item["status"] == "succeeded":
                return job
            if item["status"] == "failed" and status not in {"failed", "succeeded"}:
                raise ValueError("请通过重试操作重新执行失败项目。")
            normalized_output = os.path.abspath(os.fspath(output)) if output else ""
            size, modified = _file_stat(normalized_output) if status == "succeeded" else (None, None)
            now = time.time()
            db.execute("""UPDATE export_items SET status=?,output=?,output_size=?,output_mtime_ns=?,
                error=?,snapshot_json=COALESCE(?,snapshot_json),updated_at=? WHERE job_id=? AND item_index=?""",
                       (status, normalized_output, size, modified, str(error or ""), snapshot, now, job_id, index))
            db.execute("UPDATE export_jobs SET updated_at=? WHERE id=?", (now, job_id))
            return self._job(db, job_id)

    @staticmethod
    def _finished_state(db, job_id):
        states = {row[0] for row in db.execute("SELECT status FROM export_items WHERE job_id=?", (job_id,))}
        if states & {"queued", "running", "paused"}:
            return "paused"
        return "failed" if "failed" in states else "completed"

    def finish_job(self, job_id, cancelled=False, error=""):
        with self._connection(write=True) as db:
            job = self._job(db, job_id)
            self._editable(job)
            now = time.time()
            status = "paused" if cancelled else "failed"
            message = str(error or ("" if cancelled else "未收到完成记录，请重试此项目。"))
            db.execute("""UPDATE export_items SET status=?,error=?,updated_at=?
                WHERE job_id=? AND status IN ('queued','running')""", (status, message, now, job_id))
            state = self._finished_state(db, job_id)
            db.execute("UPDATE export_jobs SET status=?,error=?,updated_at=? WHERE id=?",
                       (state, str(error or ""), now, job_id))
            return self._job(db, job_id)

    def recover_interrupted(self):
        """Make interrupted work explicitly resumable; never infer completion."""
        with self._connection(write=True) as db:
            rows = db.execute("""SELECT DISTINCT j.id FROM export_jobs j
                LEFT JOIN export_items i ON i.job_id=j.id
                WHERE j.removed=0 AND (j.status='running' OR i.status='running')""").fetchall()
            now = time.time()
            for row in rows:
                identifier = row["id"]
                db.execute("""UPDATE export_items SET status='paused',updated_at=?
                    WHERE job_id=? AND status IN ('queued','running')""", (now, identifier))
                state = self._finished_state(db, identifier)
                db.execute("UPDATE export_jobs SET status=?,updated_at=? WHERE id=?", (state, now, identifier))
            return len(rows)

    def _requeue(self, job_id, failed_only):
        with self._connection(write=True) as db:
            job = self._job(db, job_id)
            self._editable(job)
            if job["status"] == "running":
                raise ValueError("运行中的任务不能重新排队。")
            now = time.time()
            selected = {"failed"} if failed_only else {"queued", "paused"}
            for item in job["items"]:
                if item["status"] in selected:
                    db.execute("""UPDATE export_items SET status='queued',error='',output='',output_size=NULL,
                        output_mtime_ns=NULL,snapshot_json=NULL,updated_at=? WHERE job_id=? AND item_index=?""",
                               (now, job_id, item["index"]))
            has_queued = db.execute("SELECT 1 FROM export_items WHERE job_id=? AND status='queued'", (job_id,)).fetchone()
            state = "queued" if has_queued else self._finished_state(db, job_id)
            db.execute("UPDATE export_jobs SET status=?,error='',updated_at=? WHERE id=?", (state, now, job_id))
            return self._job(db, job_id)

    def resume(self, job_id):
        return self._requeue(job_id, failed_only=False)

    def retry_failed(self, job_id):
        return self._requeue(job_id, failed_only=True)

    def remove_pending(self, job_id):
        with self._connection(write=True) as db:
            job = self._job(db, job_id)
            if job["status"] == "running":
                raise ValueError("请先停止正在运行的任务。")
            db.execute("UPDATE export_jobs SET removed=1,updated_at=? WHERE id=?", (time.time(), job_id))
            return self._job(db, job_id)

    def _history_items(self, video):
        signature = _signature(video)
        with self._connection() as db:
            rows = db.execute("""SELECT i.*,j.mode,j.output_key,j.created_at,j.status AS job_status,j.removed
                FROM export_items i JOIN export_jobs j ON j.id=i.job_id
                WHERE i.source_key=? AND i.source_size=? AND i.source_mtime_ns=? AND i.profile=?
                ORDER BY i.updated_at DESC,j.created_at DESC""", signature).fetchall()
            return [dict(row) for row in rows]

    def history_for(self, video):
        result = {"status": "unrestored", "modes": [], "outputs": [], "failures": [], "missing_outputs": []}
        rows = self._history_items(video)
        active = []
        for row in rows:
            entry = {"mode": row["mode"], "output": row["output"], "job_id": row["job_id"],
                     "index": row["item_index"], "created_at": row["created_at"], "error": row["error"]}
            if row["status"] == "succeeded":
                target = "outputs" if self._valid_output(row) else "missing_outputs"
                result[target].append(entry)
            elif row["status"] == "failed":
                result["failures"].append(entry)
            elif not row["removed"]:
                active.append(row["status"])
        result["modes"] = [mode for mode in ("sdr", "hlg") if any(row["mode"] == mode for row in result["outputs"])]
        result["status"] = next((state for state in ("running", "queued", "paused") if state in active),
                                "succeeded" if result["outputs"] else "failed" if result["failures"]
                                else "missing" if result["missing_outputs"] else "unrestored")
        return result

    def restored_gray_items(self):
        """Valid successful Log/HLG outputs, including hidden queue history."""
        with self._connection() as db:
            rows = db.execute("""SELECT * FROM export_items
                WHERE status='succeeded' AND profile IN ('dlog','dlog2','hlg')
                ORDER BY updated_at DESC""").fetchall()
        return [dict(row) for row in rows if self._valid_output(row)]

    def duplicate_outputs(self, video, mode, output_dir):
        key = _path_key(output_dir)
        return list(dict.fromkeys(row["output"] for row in self._history_items(video)
                                  if row["mode"] == mode and row["output_key"] == key
                                  and self._valid_output(row)))
