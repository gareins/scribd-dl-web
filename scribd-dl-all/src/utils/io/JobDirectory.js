import fs from 'fs'
import path from 'path'
import { directoryIo } from "./DirectoryIo.js"
import { configLoader } from "./ConfigLoader.js"
import * as scribdJob from '../../const/ScribdJob.js'

class JobDirectory {
    constructor() {
        if (!JobDirectory.instance) {
            JobDirectory.instance = this
        }
        return JobDirectory.instance
    }

    /**
     * Root directory that holds all job directories
     * @returns {string}
     */
    root(output) {
        return path.join(output, scribdJob.JOB_DIR)
    }

    /**
     * Directory for a single document job, keyed by the embed id
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @returns {string}
     */
    dir(output, docId) {
        return path.join(this.root(output), docId)
    }

    /**
     * Create the job directory layout, idempotent
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @returns {Promise<string>} the job directory path
     */
    async create(output, docId) {
        const dir = this.dir(output, docId)
        await directoryIo.create(path.join(dir, scribdJob.PAGES_DIR))
        return dir
    }

    /**
     * File extension for a rendered page, derived from the image codec config
     * @returns {string}
     */
    pageExt() {
        const format = (configLoader.load("IMAGE", "format") || "png").toLowerCase()
        return format === "jpeg" ? "jpg" : "png"
    }

    /**
     * Path of a single page render artifact
     * @param {string} output  path of the output directory
     * @param {string} docId   embedded document id
     * @param {number} index   1-based page index
     * @returns {string}
     */
    pageFile(output, docId, index) {
        return path.join(this.dir(output, docId), scribdJob.PAGES_DIR, `${index.toString().padStart(4, 0)}.${this.pageExt()}`)
    }

    /**
     * Create or reconcile the authoritative per-page state and persist it.
     *
     * Fast path when the page count is unchanged (e.g. resuming the same job).
     * If the count drifted because the document changed, the pages list is
     * rebuilt: resolved (done/skipped) pages keep their status only if their
     * render file still exists, otherwise they fall back to pending.
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @param {number} total  expected number of pages
     */
    async init(output, docId, total) {
        let manifest = this.readManifest(output, docId)
        if (!manifest) {
            manifest = { total: 0, pages: [] }
        }
        if (manifest.pages.length === total && manifest.total === total) {
            // unchanged page count: still downgrade any resolved page whose
            // render file disappeared between runs so it gets re-rendered
            let changed = false
            for (const page of manifest.pages) {
                if ((page.status === scribdJob.STATUS_DONE || page.status === scribdJob.STATUS_SKIPPED) && !fs.existsSync(page.file)) {
                    page.status = scribdJob.STATUS_PENDING
                    changed = true
                }
            }
            if (changed) {
                await this.writeManifest(output, docId, manifest)
            }
            return manifest
        }

        const previous = new Map(manifest.pages.map(page => [page.page, page]))
        manifest.total = total
        manifest.pages = []
        for (let i = 1; i <= total; i++) {
            const file = this.pageFile(output, docId, i)
            const prev = previous.get(i)
            if (prev && (prev.status === scribdJob.STATUS_DONE || prev.status === scribdJob.STATUS_SKIPPED) && fs.existsSync(file)) {
                manifest.pages.push(prev)
            } else if (prev && prev.status === scribdJob.STATUS_FAILED) {
                manifest.pages.push({ page: i, status: scribdJob.STATUS_FAILED, error: prev.error, file: file })
            } else {
                manifest.pages.push({ page: i, status: scribdJob.STATUS_PENDING, file: file })
            }
        }
        await this.writeManifest(output, docId, manifest)
        return manifest
    }

    /**
     * Indices that still need rendering (resume offset). Pages already resolved
     * as done or skipped are treated as terminal.
     * @param {object} manifest manifest state
     * @returns {number[]} 1-based page indices to render
     */
    pagesToRender(manifest) {
        const indices = []
        for (const page of manifest.pages) {
            if (page.status !== scribdJob.STATUS_DONE && page.status !== scribdJob.STATUS_SKIPPED) {
                indices.push(page.page)
            }
        }
        return indices
    }

    /**
     * Remove the resumable job artifacts (pages, manifest, progress) after the
     * final.pdf has been produced and consumed. Never called on failure.
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     */
    cleanup(output, docId) {
        const dir = this.dir(output, docId)
        const pagesDir = path.join(dir, scribdJob.PAGES_DIR)
        if (fs.existsSync(pagesDir)) {
            fs.rmSync(pagesDir, { recursive: true, force: true })
        }
        for (const name of [scribdJob.MANIFEST_FILE, scribdJob.PROGRESS_FILE]) {
            const file = path.join(dir, name)
            if (fs.existsSync(file)) {
                fs.rmSync(file, { force: true })
            }
        }
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }

    /**
     * Load the manifest for an existing job directory
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @returns {object|null} manifest state, null if the job does not exist yet
     */
    readManifest(output, docId) {
        const file = path.join(this.dir(output, docId), scribdJob.MANIFEST_FILE)
        if (!fs.existsSync(file)) {
            return null
        }
        return JSON.parse(fs.readFileSync(file, { encoding: "utf-8" }))
    }

    /**
     * Persist the manifest as the source of truth
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @param {object} manifest manifest state
     */
    writeManifest(output, docId, manifest) {
        const file = path.join(this.dir(output, docId), scribdJob.MANIFEST_FILE)
        fs.writeFileSync(file, JSON.stringify(manifest, null, 4), { encoding: "utf-8" })
        this.writeProgress(output, docId, manifest)
    }

    /**
     * Lightweight live counters for the web layer, kept in sync with the manifest
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @param {object} manifest manifest state
     */
    writeProgress(output, docId, manifest) {
        const done = manifest.pages.filter(page => page.status === scribdJob.STATUS_DONE).length
        const failed = manifest.pages.filter(page => page.status === scribdJob.STATUS_FAILED).length
        const skipped = manifest.pages.filter(page => page.status === scribdJob.STATUS_SKIPPED).length
        const file = path.join(this.dir(output, docId), scribdJob.PROGRESS_FILE)
        fs.writeFileSync(file, JSON.stringify({
            docId: docId,
            total: manifest.total,
            done: done,
            failed: failed,
            skipped: skipped,
            pending: manifest.total - done - failed - skipped
        }, null, 4), { encoding: "utf-8" })
    }

    /**
     * Mark a single page as done (written through to disk)
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @param {number} index  1-based page index
     */
    async markDone(output, docId, index) {
        const manifest = this.readManifest(output, docId)
        if (!manifest || index < 1 || index > manifest.pages.length) {
            return
        }
        const page = manifest.pages[index - 1]
        if (page.status === scribdJob.STATUS_DONE) {
            return
        }
        page.status = scribdJob.STATUS_DONE
        await this.writeManifest(output, docId, manifest)
    }

    /**
     * Mark a single page as failed (written through to disk)
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @param {number} index  1-based page index
     * @param {string} error  reason for the failure
     */
    async markFailed(output, docId, index, error) {
        const manifest = this.readManifest(output, docId)
        if (!manifest || index < 1 || index > manifest.pages.length) {
            return
        }
        const page = manifest.pages[index - 1]
        if (page.status === scribdJob.STATUS_DONE) {
            return
        }
        page.status = scribdJob.STATUS_FAILED
        page.error = error
        await this.writeManifest(output, docId, manifest)
    }

    /**
     * Mark a single page as skipped (written through to disk)
     * @param {string} output path of the output directory
     * @param {string} docId  embedded document id
     * @param {number} index  1-based page index
     * @param {string} error  reason for the skip
     */
    async markSkipped(output, docId, index, error) {
        const manifest = this.readManifest(output, docId)
        if (!manifest || index < 1 || index > manifest.pages.length) {
            return
        }
        const page = manifest.pages[index - 1]
        if (page.status === scribdJob.STATUS_DONE) {
            return
        }
        page.status = scribdJob.STATUS_SKIPPED
        page.error = error
        await this.writeManifest(output, docId, manifest)
    }
}

export const jobDirectory = new JobDirectory()
