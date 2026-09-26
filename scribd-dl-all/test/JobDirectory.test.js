import fs from 'fs'
import path from 'path'
import os from 'os'
import { jobDirectory } from "../src/utils/io/JobDirectory.js";
import * as scribdJob from "../src/const/ScribdJob.js";

const output = path.join(os.tmpdir(), `scribd-dl-test-${process.pid}-${Date.now()}`)

let docId
let jobDir

beforeEach(async () => {
    docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    jobDir = jobDirectory.dir(output, docId)
    await jobDirectory.create(output, docId)
})

afterAll(() => {
    if (fs.existsSync(output)) {
        fs.rmSync(output, { recursive: true, force: true })
    }
})

/** init a job and mark a page done, writing a real file so file-existence checks pass */
async function doneWithFile(total, index) {
    const manifest = await jobDirectory.init(output, docId, total)
    const file = jobDirectory.pageFile(output, docId, index)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'x')
    await jobDirectory.markDone(output, docId, index)
    return file
}

function readProgress() {
    return JSON.parse(fs.readFileSync(path.join(jobDir, scribdJob.PROGRESS_FILE), { encoding: "utf-8" }))
}

describe("JobDirectory", () => {
    test("create the job directory layout", async () => {
        const dir = await jobDirectory.create(output, docId)
        expect(dir).toBe(jobDir)
        expect(fs.existsSync(path.join(jobDir, scribdJob.PAGES_DIR))).toBe(true)
    })

    test("init writes a pending manifest and progress file", async () => {
        const manifest = await jobDirectory.init(output, docId, 3)
        expect(manifest.total).toBe(3)
        expect(manifest.pages.length).toBe(3)
        expect(manifest.pages[0].status).toBe(scribdJob.STATUS_PENDING)
        expect(manifest.pages[0].file).toBe(jobDirectory.pageFile(output, docId, 1))

        const progress = readProgress()
        expect(progress.done).toBe(0)
        expect(progress.pending).toBe(3)
    })

    test("init is idempotent for an unchanged page count", async () => {
        await doneWithFile(3, 1)
        const manifest = await jobDirectory.init(output, docId, 3)
        expect(manifest.pages.length).toBe(3)
        expect(manifest.pages[0].status).toBe(scribdJob.STATUS_DONE)
    })

    test("markDone updates manifest and progress", async () => {
        await doneWithFile(3, 1)
        await jobDirectory.markDone(output, docId, 2)
        const manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[1].status).toBe(scribdJob.STATUS_DONE)

        const progress = readProgress()
        expect(progress.done).toBe(2)
        expect(progress.pending).toBe(1)
    })

    test("markFailed then markSkipped do not override a done page", async () => {
        const file = await doneWithFile(3, 1)
        await jobDirectory.markFailed(output, docId, 1, "boom")
        let manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[0].status).toBe(scribdJob.STATUS_DONE)
        fs.writeFileSync(file, 'x')

        await jobDirectory.markFailed(output, docId, 2, "boom")
        manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[1].status).toBe(scribdJob.STATUS_FAILED)
        expect(manifest.pages[1].error).toBe("boom")

        await jobDirectory.markSkipped(output, docId, 2, "no")
        manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[1].status).toBe(scribdJob.STATUS_SKIPPED)
        expect(manifest.pages[1].error).toBe("no")
    })

    test("readManifest returns null for an unknown job", () => {
        expect(jobDirectory.readManifest(output, "999999")).toBeNull()
    })

    test("pageFile is zero-padded within the pages directory", () => {
        expect(jobDirectory.pageFile(output, docId, 42)).toBe(path.join(output, scribdJob.JOB_DIR, docId, scribdJob.PAGES_DIR, `0042.${jobDirectory.pageExt()}`))
    })

    test("pagesToRender skips done and skipped (resume offset)", async () => {
        await doneWithFile(6, 1)
        await doneWithFile(6, 2)
        await jobDirectory.markFailed(output, docId, 4, "boom")
        await jobDirectory.markSkipped(output, docId, 3, "no")

        const manifest = jobDirectory.readManifest(output, docId)
        expect(jobDirectory.pagesToRender(manifest)).toEqual([4, 5, 6])
    })

    test("init reconciles a changed page count", async () => {
        await doneWithFile(5, 2)

        const shrunk = await jobDirectory.init(output, docId, 2)
        expect(shrunk.total).toBe(2)
        expect(shrunk.pages.length).toBe(2)
        expect(shrunk.pages[1].status).toBe(scribdJob.STATUS_DONE)

        const grown = await jobDirectory.init(output, docId, 4)
        expect(grown.total).toBe(4)
        expect(grown.pages.length).toBe(4)
        expect(grown.pages[1].status).toBe(scribdJob.STATUS_DONE)
        expect(grown.pages[2].status).toBe(scribdJob.STATUS_PENDING)
    })

    test("init resets a resolved page to pending when its render file is missing", async () => {
        const file = await doneWithFile(3, 3)
        fs.rmSync(file, { force: true })

        const manifest = await jobDirectory.init(output, docId, 3)
        expect(manifest.pages[2].status).toBe(scribdJob.STATUS_PENDING)
    })

    test("cleanup removes all job artifacts and the job directory", async () => {
        await doneWithFile(3, 1)
        expect(fs.existsSync(path.join(jobDir, scribdJob.PAGES_DIR))).toBe(true)
        expect(fs.existsSync(path.join(jobDir, scribdJob.MANIFEST_FILE))).toBe(true)
        expect(fs.existsSync(path.join(jobDir, scribdJob.PROGRESS_FILE))).toBe(true)

        jobDirectory.cleanup(output, docId)
        expect(fs.existsSync(jobDir)).toBe(false)
        expect(jobDirectory.readManifest(output, docId)).toBeNull()
    })
})