import fs from 'fs'
import path from 'path'
import os from 'os'
import { jobDirectory } from "../src/utils/io/JobDirectory.js";
import * as scribdJob from "../src/const/ScribdJob.js";

const output = path.join(os.tmpdir(), `scribd-dl-test-${process.pid}-${Date.now()}`)
const docId = "123456"

afterAll(() => {
    if (fs.existsSync(output)) {
        fs.rmSync(output, { recursive: true, force: true })
    }
})

describe("JobDirectory", () => {
    test("create job directory layout", async () => {
        const dir = await jobDirectory.create(output, docId)
        expect(dir).toBe(path.join(output, scribdJob.JOB_DIR, docId))
        expect(fs.existsSync(path.join(dir, scribdJob.PAGES_DIR))).toBe(true)
    })

    test("init writes a pending manifest and progress file", async () => {
        let manifest = await jobDirectory.init(output, docId, 3)
        expect(manifest.total).toBe(3)
        expect(manifest.pages.length).toBe(3)
        expect(manifest.pages[0].status).toBe(scribdJob.STATUS_PENDING)
        expect(manifest.pages[0].file).toBe(jobDirectory.pageFile(output, docId, 1))

        const progress = JSON.parse(fs.readFileSync(path.join(jobDirectory.dir(output, docId), scribdJob.PROGRESS_FILE), { encoding: "utf-8" }))
        expect(progress.done).toBe(0)
        expect(progress.pending).toBe(3)
    })

    test("init is idempotent", async () => {
        await jobDirectory.init(output, docId, 3)
        await jobDirectory.markDone(output, docId, 1)
        const manifest = await jobDirectory.init(output, docId, 3)
        expect(manifest.pages[0].status).toBe(scribdJob.STATUS_DONE)
    })

    test("markDone updates manifest and progress", async () => {
        await jobDirectory.markDone(output, docId, 2)
        const manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[1].status).toBe(scribdJob.STATUS_DONE)
        const progress = JSON.parse(fs.readFileSync(path.join(jobDirectory.dir(output, docId), scribdJob.PROGRESS_FILE), { encoding: "utf-8" }))
        expect(progress.done).toBe(2)
        expect(progress.pending).toBe(1)
    })

    test("markFailed then markSkipped do not override a done page", async () => {
        await jobDirectory.markFailed(output, docId, 2, "boom")
        let manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[1].status).toBe(scribdJob.STATUS_DONE)

        await jobDirectory.markFailed(output, docId, 3, "boom")
        manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[2].status).toBe(scribdJob.STATUS_FAILED)
        expect(manifest.pages[2].error).toBe("boom")

        await jobDirectory.markSkipped(output, docId, 1, "no")
        manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[0].status).toBe(scribdJob.STATUS_DONE)
        expect(manifest.pages[0].error).toBeUndefined()

        await jobDirectory.markSkipped(output, docId, 3, "no")
        manifest = jobDirectory.readManifest(output, docId)
        expect(manifest.pages[2].status).toBe(scribdJob.STATUS_SKIPPED)
        expect(manifest.pages[2].error).toBe("no")
    })

    test("readManifest returns null for an unknown job", () => {
        expect(jobDirectory.readManifest(output, "999999")).toBeNull()
    })

    test("pageFile is zero-padded within the pages directory", () => {
        expect(jobDirectory.pageFile(output, docId, 42)).toBe(path.join(output, scribdJob.JOB_DIR, docId, scribdJob.PAGES_DIR, "0042.png"))
    })
})