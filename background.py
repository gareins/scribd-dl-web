import queue
import os
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
        if url in self.items:
            # already processed
            return

        self.items[url] = {
            'url': url,
            'status': TaskStatus.PENDING,
            'data': None,
            'error': None,
            'stdout': []
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
                item['stdout'].append(line.strip())
                logger.debug(line.strip())
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
                
            with open(pdf_path, 'rb') as f:
                pdf_content = f.read()
            os.remove(pdf_path)
                
            # Store PDF content and filename
            item['status'] = TaskStatus.COMPLETED
            item['data'] = {'filename': pdf_filename, 'content': pdf_content}
            
        except subprocess.SubprocessError as e:
            item['status'] = TaskStatus.FAILED
            item['error'] = "Subprocess error"
            item['data'] = (repr(e), traceback.format_exc())
            self._report_error(e, item['error'])

        logger.info(f"Completed task {url} with status {item['status']}")

    def get_status(self, url):
        if url not in self.items:
            return None
        return {
            'status': self.items[url]['status'].value,
            'error': self.items[url]['error'],
            'queue': self.queue.qsize()
        }

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
