import puppeteer from 'puppeteer'
import axios from 'axios';
import dns from 'node:dns';

async function lookupIp() {
    return new Promise((resolve, reject) => {
        dns.lookup('browser', (err, address, family) => {
            if(err) reject(err);
            resolve(address);
        });
   });
};

class PuppeteerSg {
  constructor() {
    if (!PuppeteerSg.instance) {
      PuppeteerSg.instance = this;
      process.on('exit', () => {
        this.close();
      });
    }
    return PuppeteerSg.instance;
  }

  /**
   * Launch a browser
   */
  async launch() {
    const ip_address = await lookupIp();
    const response = await axios.get('http://' + ip_address + ':9222/json/version');
    this.browser = await puppeteer.connect({
        browserWSEndpoint: response.data.webSocketDebuggerUrl,
        defaultViewport: null,
    });
  }

  /**
   * New a page
   * @param {string} url 
   * @returns 
   */
  async getPage(url) {
    if (!this.browser) {
      await this.launch({headless: true, timeout: 0, protocolTimeout: 600000})
    }
    let page = await this.browser.newPage()
    await page.goto(url, {
      waitUntil: "load",
    })
    return page
  }

  /**
   * Close the browser
   */
  async close() {
    if (this.browser) {
      await this.browser.disconnect();
      this.browser = null;
    }
  }
}

export const puppeteerSg = new PuppeteerSg()