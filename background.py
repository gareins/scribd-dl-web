import queue
import os
import re
import json
import subprocess
import threading
import traceback
import logging
from enum import Enum

WORK_DIR = os.path.abspath("./scribd-dl")
logger = logging.getLogger(__name__)

class TaskStatus(Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"

def _doc_id(url):
    """Best-effort extraction of a scribd document id from a url."""
    m = re.search(r'\.scribd\.com/(?:embeds/|(?:document|doc)/)(\d+)', url)
    return m.group(1) if m else None

def _job_progress_from_disk(url):
    """Reconstruct progress for a job that outlived its process.

    Reads output/.jobs/<docId>/progress.json when present. Returns a dict with
    progress counters and a partial flag, or None when no checkpoint exists.
    """
    doc_id = _doc_id(url)
    if not doc_id:
        return None
    progress_path = os.path.join(WORK_DIR, 'output', '.jobs', doc_id, 'progress.json')
    if not os.path.exists(progress_path):
        return None
    try:
        with open(progress_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        done = int(data.get('done', 0))
        total = int(data.get('total', 0))
        return {
            'progress': {'done': done, 'total': total},
            'partial': total > 0 and done < total,
        }
    except (ValueError, OSError):
        return None

def _move_to_cache(doc_id, pdf_path):
    """Move the finished PDF into the web cache and return its new path.

    The scribd-dl job owns all other files and wipes the job directory on
    success, so the only artifact the web must pick up is the final PDF that
    was reported on stdout via "Generated:".
    """
    cache_dir = os.path.join(WORK_DIR, 'output', 'cache')
    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, '{}.pdf'.format(doc_id if doc_id else 'download'))
    os.replace(pdf_path, cache_path)
    return cache_path

class BackgroundWorker:
    def __init__(self):
        self.queue = queue.Queue()
        self.items = {}
        self._running = False
        self._worker_thread = threading.Thread(target=self._process_queue)
        self._worker_thread.daemon = True

    def _report_error(e):
        logger.error('Detected unknown error: ' + repr(e))
        logger.error(traceback.format_exc())

    def start(self):
        self._running = True
        self._worker_thread.start()
        logger.info('background thread started')

    def submit_url(self, url):
        if url in self.items and self.items[url]['status'] == TaskStatus.PROCESSING:
            # already running, don't double-enqueue
            return

        if url in self.items:
            # finished before; allow a fresh run. Re-submitting a URL that has a
            # partial on-disk job auto-resumes it (npm start <url> continues it).
            del self.items[url]

        self.items[url] = {
            'url': url,
            'status': TaskStatus.PENDING,
            'data': None,
            'error': None,
            'stdout': [],
            'progress': None,
            'resumable': False,
            'page_error': None,
        }

        logger.debug('Enqued:' + url)
        self.queue.put(url)

    def _process_queue(self):
        """Background thread that processes items from the queue."""
        logger.debug('background thread running')

        while self._running:
            try:
                url = self.queue.get(timeout=1)
                self._process_item(url)
            except queue.Empty:
                continue
            except Exception as e:
                self._report_error(f"Error processing queue: {e}")

            self.queue.task_done()

    def _parse_heartbeat(self, item, line):
        """Extract progress / resumable / page_error from JobRunner stdout lines."""
        if line.startswith('PROGRESS '):
            m = re.match(r'^PROGRESS (\d+)/(\d+)$', line)
            if m:
                item['progress'] = {'done': int(m.group(1)), 'total': int(m.group(2))}
        elif line.startswith('RESUME '):
            m = re.match(r'^RESUME (\d+)/(\d+)$', line)
            if m:
                item['resumable'] = True
                item['progress'] = {'done': int(m.group(1)), 'total': int(m.group(2))}
        elif line.startswith('FAILED '):
            marker = ': '
            item['page_error'] = line.split(marker, 1)[1] if marker in line else line
        elif line.startswith('COMPLETE '):
            m = re.match(r'^COMPLETE (\d+)/(\d+)$', line)
            if m:
                item['progress'] = {'done': int(m.group(1)), 'total': int(m.group(2))}

    def _process_item(self, url):
        logger.info(f"Start processing for {url}")
        item = self.items[url]

        # check if someone else completed this in the meanwhile
        if item['status'] == TaskStatus.COMPLETED:
            return

        item['status'] = TaskStatus.PROCESSING
        try:
            # Run npm command with proper CWD
            command = f"npm start {url}".split()
            logger.info(f"Starting background process for {url}")

            process = subprocess.Popen(
                command,
                cwd=WORK_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                universal_newlines=True
            )
            
            # Collect stdout lines
            for line in iter(process.stdout.readline, ''):
                line = line.strip()
                item['stdout'].append(line)
                logger.debug(line)
                self._parse_heartbeat(item, line)
                if process.poll() is not None:
                    break
                    
            # Wait for process to finish
            process.wait()
            logger.info(f"Backgroud proccess finished for {url}")
            
            # Check if process succeeded
            if process.returncode != 0:
                item['status'] = TaskStatus.FAILED
                item['error'] = f"scribdl command failed with exit code {process.returncode}"
                item['data'] = '\n'.join(item['stdout'])
                logger.warning("{}:{}".format(url, item['error']))
                return
                
            # Find generated PDF filename from stdout
            pdf_filename = None
            for line in item['stdout']:
                if line.startswith('Generated:'):
                    pdf_filename = line.split(':', 1)[1].strip()
                    break
                    
            if not pdf_filename:
                item['status'] = TaskStatus.FAILED
                item['error'] = 'No Generated file found in output'
                logger.warning("{}:{}".format(url, item['error']))
                return
                
            # Read the generated PDF file
            pdf_path = os.path.join(WORK_DIR, pdf_filename)
            if not os.path.exists(pdf_path):
                item['status'] = TaskStatus.FAILED
                item['error'] = f'Generated PDF not found'
                item['data'] = pdf_path
                logger.warning("{}:{}".format(url, item['error']))
                return
                
            # Move the finished PDF into the web cache (JS owns all other files
            # and already cleaned the job directory on success)
            cache_path = _move_to_cache(_doc_id(url), pdf_path)

            # Store the cached file path for serving
            item['status'] = TaskStatus.COMPLETED
            item['data'] = {'filename': pdf_filename, 'path': cache_path}
            
        except subprocess.SubprocessError as e:
            item['status'] = TaskStatus.FAILED
            item['error'] = "Subprocess error"
            item['data'] = (repr(e), traceback.format_exc())
            self._report_error(e, item['error'])

        logger.info(f"Completed task {url} with status {item['status']}")

    def get_status(self, url):
        if url in self.items:
            item = self.items[url]
            result = {
                'status': item['status'].value,
                'error': item['error'],
                'queue': self.queue.qsize(),
                'progress': item.get('progress'),
                'resumable': bool(item.get('resumable')),
                'page_error': item.get('page_error'),
            }
        else:
            result = {
                'status': 'not_found',
                'error': 'This url is not being processed',
                'progress': None,
                'resumable': False,
                'page_error': None,
            }

        # Reconstruct state for a job that outlived its process
        disk = _job_progress_from_disk(url)
        if disk:
            if result['progress'] is None:
                result['progress'] = disk['progress']
            if disk['partial'] and not result['resumable']:
                result['resumable'] = True

        return result

    def get_result(self, url):
        if url not in self.items or self.items[url]['status'] != TaskStatus.COMPLETED:
            return None
        return self.items[url]['data']

    def get_error(self, url):
        if url not in self.items or self.items[url]['status'] != TaskStatus.FAILED:
            return None
        return (self.items[url]['error'], self.items[url]['data'])

    def get_queue_size(self):
        """Get current number of items waiting in queue."""
        return self.queue.qsize()

    def insert_invalid(self, url, error):
        self.items[url] = {
            'status': TaskStatus.FAILED,
            'error': error,
        }

    def shutdown(self):
        """Shutdown the background worker."""
        self._running = False
        self._worker_thread.join(timeout=5)
