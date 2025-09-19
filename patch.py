import re
import sys

# Pattern matches: '  async launch()' followed by any characters until '  }'
path1 = '/src/utils/request/PuppeteerSg.js'
pattern1 = r'^  async launch\(\) \{([\s\S]*?)^  \}'
replacement1 = """  async launch() {
    const ip_address = await lookupIp();
    const response = await axios.get('http://' + ip_address + ':9222/json/version');
    this.browser = await puppeteer.connect({
        browserWSEndpoint: response.data.webSocketDebuggerUrl,
        defaultViewport: null,
    });
  }"""
head1 = """import axios from 'axios';
import dns from 'node:dns';

async function lookupIp() {
    return new Promise((resolve, reject) => {
        dns.lookup('browser', (err, address, family) => {
            if(err) reject(err);
            resolve(address);
        });
   });
};
"""

path2 = '/package.json'
pattern2 = '0.33.3'
replacement2 = '0.33.5'

root = sys.argv[1]

with open(root + path1, 'r') as fp:
    content = fp.read()
    
result = re.sub(pattern1, replacement1, content, flags=re.MULTILINE)

with open(root + path1, 'w') as fp:
    fp.write(head1 + result)

with open(root + path2, 'r') as fp:
    result = fp.read().replace(pattern2, replacement2)
with open(root + path2, 'w') as fp:
    fp.write(result)
