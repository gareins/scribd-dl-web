from flask import Flask, render_template, request, jsonify

import tempfile
import logging

from background import BackgroundWorker

app = Flask(__name__)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

background_worker = BackgroundWorker()
with app.app_context():
    background_worker.start()

@app.route('/')
def index():
    error = None
    success = None
    file_path = None
    
    return render_template('index.html', success=success, file_path=file_path)

@app.route('/start-processing', methods=['POST'])
def start_processing():
    """Submit a new job to the queue"""
    # URL validation
    url = request.get_json().get('url')
    if not url.startswith(('http://', 'https://')):
        background_worker.insert_invalid(url, 'Invalid URL, http(s) not found')
        return check_status(url)
    
    # Check if we're at max capacity
    if background_worker.get_queue_size() >= 5:
        return jsonify({'error': 'Queue is full'}), 429
    
    # Schedule the job
    background_worker.submit_url(url)
    
    return jsonify(background_worker.get_status(url))


@app.route('/status')
def check_status(url=None):
    if url is None:
        url = request.args.get('url')

    result = background_worker.get_status(url)
    if result is None:
        result = {'status': 'not_found', 'error': 'This url is not being processed'}

    logger.debug('status:' + repr(result))
    return jsonify(result)

@app.route('/download')
def download_file():
    url = request.args.get('url')
    data = background_worker.get_result(url)
    if data is None:
        return 'Task not found or not completed', 404
        
    return data['content'], 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': f'attachment; filename="{data["filename"]}"'
    }

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')

