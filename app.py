from flask import Flask, render_template_string, request, send_from_directory, jsonify
import subprocess
import os.path
from werkzeug.utils import secure_filename
import tempfile
from threading import Thread
import uuid

app = Flask(__name__)

WORK_DIR = os.path.abspath("./scribd-dl")
TITLE = "SCRIBD PDF Download"

# Create temporary directory for files
UPLOAD_FOLDER = tempfile.mkdtemp()
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Dictionary to store processing status
processing_status = {}

def process_url(url, task_id):
    """Process URL using npm in background thread"""
    processing_status[task_id] = {'status': 'processing', 'error': None}
    
    try:
        # Run npm command with proper CWD
        command = f"npm start {url}"
        process = subprocess.Popen(
            command,
            cwd=WORK_DIR,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True
        )
        
        # Collect stdout lines
        stdout_lines = []
        for line in iter(process.stdout.readline, ''):
            stdout_lines.append(line.strip())
            if process.poll() is not None:
                break
                
        # Wait for process to finish
        process.wait()
        
        # Check if process succeeded
        if process.returncode != 0:
            error_message = '\n'.join(stdout_lines[-5:])  # Get last 5 lines of output
            processing_status[task_id]['status'] = 'error'
            processing_status[task_id]['error'] = f"Command failed with exit code {process.returncode}\n{error_message}"
            return
            
        # Find generated PDF filename from stdout
        pdf_filename = None
        for line in stdout_lines:
            if line.startswith('Generated:'):
                pdf_filename = line.split(':', 1)[1].strip()
                break
                
        if not pdf_filename:
            processing_status[task_id]['status'] = 'error'
            processing_status[task_id]['error'] = 'No Generated file found in output'
            return
            
        # Read the generated PDF file
        pdf_path = os.path.join(WORK_DIR, pdf_filename)
        if not os.path.exists(pdf_path):
            processing_status[task_id]['status'] = 'error'
            processing_status[task_id]['error'] = f'Generated PDF not found at {pdf_path}'
            return
            
        with open(pdf_path, 'rb') as f:
            pdf_content = f.read()
            
        # Store PDF content and filename
        processing_status[task_id]['status'] = 'completed'
        processing_status[task_id]['filename'] = pdf_filename
        processing_status[task_id]['content'] = pdf_content
        
    except subprocess.SubprocessError as e:
        processing_status[task_id]['status'] = 'error'
        processing_status[task_id]['error'] = f'Subprocess error: {str(e)}'
    except Exception as e:
        processing_status[task_id]['status'] = 'error'
        processing_status[task_id]['error'] = f'Unexpected error: {str(e)}'


def render_page(**kwargs):
    template = """
<!DOCTYPE html>
<html>
<head>
    <title>{{ title }}</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 20px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input[type="text"] { width: 100%; padding: 8px; }
        button { background-color: #007bff; color: white; padding: 10px 15px; border: none; cursor: pointer; }
        .error { color: red; margin-top: 5px; }
        .success { color: green; margin-top: 5px; }
        #status { margin-top: 15px; font-weight: bold; }
    </style>
</head>
<body>
    <h1>{{ title }}</h1>
    
    {% if error %}
        <div class="error">{{ error }}</div>
    {% endif %}
    {% if success %}
        <div class="success">{{ success }}</div>
    {% endif %}
    
    <form id="urlForm" method="post">
        <div class="form-group">
            <label for="url">Enter URL:</label>
            <input type="text" id="url" name="url" required>
        </div>
        <button type="submit">Process URL</button>
    </form>

    <pre id="status"></pre>

    <script>
        document.getElementById('urlForm').onsubmit = async function(e) {
            e.preventDefault();
            
            // Show processing status
            document.getElementById('status').innerHTML = '<i>Processing...</i>';
            
            // Send request to start processing
            const response = await fetch('/start-processing', {
                method: 'POST',
                headers: new Headers({'content-type': 'application/json'}),
                body: JSON.stringify({ url: document.getElementById('url').value })
            });
            console.log(':)1');
            
            const data = await response.json();
            const taskId = data.taskId;
            
            console.log(':)2');
            // Start polling for status
            pollStatus(taskId);
        };
        
        async function pollStatus(taskId) {
            try {
                const response = await fetch(`/status/${taskId}`);
                const data = await response.json();
                
                if (data.status === 'completed') {
                    document.getElementById('status').innerHTML = 
                        `<a href='/download/${taskId}'>Download</a>`;
                } else if (data.status === 'error') {
                    document.getElementById('status').innerHTML = 
                        `<i>Error: ${data.error}</i>`;
                } else if (data.status === 'processing') {
                    // Continue polling
                    setTimeout(() => pollStatus(taskId), 1000);
                } else {
                    document.getElementById('status').innerHTML = 
                        `<i>Other error: ${data.error}</i>`;
                }
            } catch (error) {
                console.error('Error polling status:', error);
                document.getElementById('status').innerHTML = 
                    '<i>Error checking status</i>';
            }
        }
    </script>
</body>
</html>"""
    
    return render_template_string(template, title=TITLE, **kwargs)

@app.route('/', methods=['GET', 'POST'])
def index():
    error = None
    success = None
    file_path = None
    
    if request.method == 'POST':
        # URL validation
        url = request.form.get('url')
        if not url.startswith(('http://', 'https://')):
            return render_page(error="Please enter a valid HTTP or HTTPS URL", success=success, file_path=file_path)
        
        return jsonify({'taskId': str(uuid.uuid4())})
    
    return render_page(error=error, success=success, file_path=file_path)

@app.route('/start-processing', methods=['POST'])
def start_processing():
    data = request.get_json()
    task_id = str(uuid.uuid4())
    
    thread = Thread(target=process_url, args=(data['url'], task_id))
    thread.daemon = True
    thread.start()
    
    return jsonify({'taskId': task_id})

@app.route('/status/<task_id>')
def check_status(task_id):
    status = processing_status.get(task_id)
    if status:
        result = { 'status': status['status'] }
        if 'error' in status:
            result['error'] = status['error']
        return jsonify(result)

    return jsonify({'status': 'unknown'})

@app.route('/download/<task_id>')
def download_file(task_id):
    status = processing_status.get(task_id)
    if not status or status['status'] != 'completed':
        return 'Task not found or not completed', 404
        
    return status['content'], 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': f'attachment; filename="{status["filename"]}"'
    }

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')
