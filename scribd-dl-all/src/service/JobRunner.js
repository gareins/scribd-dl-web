import { puppeteerSg } from "../utils/request/PuppeteerSg.js";
import { pdfGenerator } from "../utils/io/PdfGenerator.js";
import { configLoader } from "../utils/io/ConfigLoader.js";
import { jobDirectory } from "../utils/io/JobDirectory.js";
import * as scribdRegex from "../const/ScribdRegex.js"
import * as scribdJob from "../const/ScribdJob.js"
import { Image } from "../object/Image.js"
import sharp from "sharp";
import path from 'path'
import fs from 'fs'

const output = configLoader.load("DIRECTORY", "output")
const rendertime = parseInt(configLoader.load("SCRIBD", "rendertime"))
const retries = parseInt(configLoader.load("SCRIBD", "retries"))
const skipOnError = configLoader.load("SCRIBD", "skip_on_error") === "true"

class JobRunner {
    constructor() {
        if (!JobRunner.instance) {
            JobRunner.instance = this
        }
        return JobRunner.instance
    }

    /**
     * Run the collect + assemble phases for a scribd url
     * @param {string} url package url, document or embed
     */
    async execute(url) {
        let id;
        if (url.match(scribdRegex.DOCUMENT)) {
            id = scribdRegex.DOCUMENT.exec(url)[2]
        } else if (url.match(scribdRegex.EMBED)) {
            id = scribdRegex.EMBED.exec(url)[1]
        } else {
            throw new Error(`Unsupported URL: ${url}`)
        }
        const docId = id
        const embedUrl = url.match(scribdRegex.EMBED) ? url : `https://www.scribd.com/embeds/${docId}/content`

        await jobDirectory.create(output, docId)
        await this.run(embedUrl, docId)
    }

    /**
     * Resume a previous job from its job directory. Idempotent: safe to run
     * repeatedly against a partial job.
     * @param {string} jobDir path of a job directory (output/.jobs/<docId>)
     */
    async resume(jobDir) {
        const docId = path.basename(jobDir)
        const expected = jobDirectory.dir(output, docId)
        if (path.resolve(expected) !== path.resolve(jobDir)) {
            throw new Error(`Job directory must live under the configured output (.jobs): ${expected}`)
        }
        if (!jobDirectory.readManifest(output, docId)) {
            throw new Error(`No manifest.json found; not a resumeable job: ${jobDir}`)
        }
        await jobDirectory.create(output, docId)
        await this.run(`https://www.scribd.com/embeds/${docId}/content`, docId)
    }

    /**
     * Shared collect + assemble execution with guaranteed browser cleanup
     * @param {string} embedUrl full embed url
     * @param {string} docId    embedded document id
     */
    async run(embedUrl, docId) {
        const dir = jobDirectory.dir(output, docId)
        try {
            const manifest = await this.collect(embedUrl, docId)
            await this.assemble(docId, manifest, dir)
        } finally {
            await puppeteerSg.close()
        }
    }

    /**
     * Resolve a page's pixels-to-points dimensions from its inline style
     * @param {object} element puppeteer element handle for an outer_page_*
     * @returns {Promise<{width:number,height:number}>}
     */
    async pageDimensions(element) {
        let width = 1191
        let height = 1684
        const style = await element.evaluate((el) => el.getAttribute("style"));
        if (style.includes("width:") && style.includes("height:")) {
            height = Math.ceil(width * parseInt(style.split("height:")[1].split("px")[0].trim()) / parseInt(style.split("width:")[1].split("px")[0].trim()))
        }
        return { width, height }
    }

    /**
     * Render a single page to its job file. Bounded retries on failure.
     * @param {object} page puppeteer page
     * @param {object} el    puppeteer element handle for the outer_page_*
     * @param {string} file  destination png path
     * @param {number} index 1-based page index
     * @returns {Promise<{width:number,height:number}>} rendered page dimensions
     */
    async renderPage(page, el, file, index) {
        await page.evaluate((index) => { // eslint-disable-next-line
            document.getElementById(`outer_page_${index}`).scrollIntoView()
        }, index)

        const { width, height } = await this.pageDimensions(el)
        await page.setViewport({ width: width, height: height, deviceScaleFactor: 2 });

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await el.screenshot({ path: file })
                return { width, height }
            } catch (err) {
                if (fs.existsSync(file)) {
                    fs.rmSync(file, { force: true })
                }
                if (attempt === retries) {
                    throw err
                }
            }
        }
    }

    /**
     * Write a white placeholder image for a broken page so the page count holds
     * @param {string} file  destination png path
     * @param {number} width rendered width
     * @param {number} height rendered height
     */
    async writePlaceholder(file, width, height) {
        await sharp({
            create: {
                width: Math.max(1, width),
                height: Math.max(1, height),
                channels: 3,
                background: { r: 255, g: 255, b: 255 }
            }
        }).png().toFile(file)
    }

    /**
     * Collect phase: render each page independently to the job's pages dir,
     * writing the manifest after every page so a crash loses nothing.
     * @param {string} url    full embed url
     * @param {string} docId  embedded document id
     * @returns {Promise<object>} the written manifest
     */
    async collect(url, docId) {
        const page = await puppeteerSg.getPage(url)

        // wait rendering
        await new Promise(resolve => setTimeout(resolve, 1000))

        // hide blockers
        let doc_container = await page.$("div.document_scroller")
        await doc_container.evaluate((el) => {
            el["style"]["bottom"] = "0px"
            el["style"]["margin-top"] = "0px"
        });
        let doc_toolbar = await page.$("div.toolbar_drop")
        await doc_toolbar.evaluate((el) => el["style"]["display"] = "none");

        // discover the outer_page_* elements (1-based indices)
        let doc_pages = await page.$$("div.outer_page_container div[id^='outer_page_']")
        let manifest = await jobDirectory.init(output, docId, doc_pages.length)

        for (let i = 0; i < doc_pages.length; i++) {
            const index = i + 1
            const status = manifest.pages[i].status
            if (status === scribdJob.STATUS_DONE || status === scribdJob.STATUS_SKIPPED) {
                continue
            }

            const file = jobDirectory.pageFile(output, docId, index)
            // drop a partially-written file from an interrupted run before re-rendering
            if (status === scribdJob.STATUS_PENDING && fs.existsSync(file)) {
                fs.rmSync(file, { force: true })
            }
            console.log(`PROGRESS ${index}/${doc_pages.length}`)

            try {
                await this.renderPage(page, doc_pages[i], file, index)
                await jobDirectory.markDone(output, docId, index)
            } catch (err) {
                console.log(`FAILED ${index}/${doc_pages.length}: ${err.message}`)
                if (skipOnError) {
                    const { width, height } = await this.pageDimensions(doc_pages[i])
                    await this.writePlaceholder(file, width, height)
                    await jobDirectory.markSkipped(output, docId, index, err.message)
                } else {
                    await jobDirectory.markFailed(output, docId, index, err.message)
                    await page.close()
                    throw new Error(`Page ${index} failed after ${retries} attempts`)
                }
            }
            await new Promise(resolve => setTimeout(resolve, rendertime))
        }

        await page.close()
        return jobDirectory.readManifest(output, docId)
    }

    /**
     * Assemble phase: cheap and idempotent, rebuilds the final pdf from the manifest.
     * @param {string} docId embedded document id
     * @param {object} manifest manifest state
     * @param {string} dir     job directory
     */
    async assemble(docId, manifest, dir) {
        const images = []
        for (const entry of manifest.pages) {
            if (entry.status !== scribdJob.STATUS_DONE && entry.status !== scribdJob.STATUS_SKIPPED) {
                continue
            }
            const metadata = await sharp(entry.file).metadata()
            images.push(new Image(entry.file, metadata.width, metadata.height))
        }
        await pdfGenerator.generate(images, path.join(dir, scribdJob.FINAL_FILE))
    }
}

export const jobRunner = new JobRunner()