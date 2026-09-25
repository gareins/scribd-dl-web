import { puppeteerSg } from "../utils/request/PuppeteerSg.js";
import { pdfGenerator } from "../utils/io/PdfGenerator.js";
import { configLoader } from "../utils/io/ConfigLoader.js";
import { jobDirectory } from "../utils/io/JobDirectory.js";
import * as scribdRegex from "../const/ScribdRegex.js"
import * as scribdJob from "../const/ScribdJob.js"
import { Image } from "../object/Image.js"
import sharp from "sharp";
import path from 'path'

const output = configLoader.load("DIRECTORY", "output")
const rendertime = parseInt(configLoader.load("SCRIBD", "rendertime"))

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

        const dir = await jobDirectory.create(output, docId)

        const manifest = await this.collect(embedUrl, docId)
        await this.assemble(docId, manifest, dir)

        await puppeteerSg.close()
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
            if (manifest.pages[i].status === scribdJob.STATUS_DONE) {
                continue
            }

            await page.evaluate((index) => { // eslint-disable-next-line
                document.getElementById(`outer_page_${index}`).scrollIntoView()
            }, index)

            let width = 1191
            let height = 1684
            let style = await doc_pages[i].evaluate((el) => el.getAttribute("style"));
            if (style.includes("width:") && style.includes("height:")) {
                height = Math.ceil(width * parseInt(style.split("height:")[1].split("px")[0].trim()) / parseInt(style.split("width:")[1].split("px")[0].trim()))
            }
            await page.setViewport({ width: width, height: height, deviceScaleFactor: 2 });

            try {
                await doc_pages[i].screenshot({ path: jobDirectory.pageFile(output, docId, index) })
                await jobDirectory.markDone(output, docId, index)
            } catch (err) {
                await jobDirectory.markFailed(output, docId, index, err.message)
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
        for (const page of manifest.pages) {
            if (page.status !== scribdJob.STATUS_DONE) {
                continue
            }
            const metadata = await sharp(page.file).metadata()
            images.push(new Image(page.file, metadata.width, metadata.height))
        }
        await pdfGenerator.generate(images, path.join(dir, scribdJob.FINAL_FILE))
    }
}

export const jobRunner = new JobRunner()