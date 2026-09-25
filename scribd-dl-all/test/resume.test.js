import fs from 'fs'
import path from 'path'
import os from 'os'
import { jest } from '@jest/globals'
import { jobRunner } from "../src/service/JobRunner.js";
import { configLoader } from "../src/utils/io/ConfigLoader.js";
import { jobDirectory } from "../src/utils/io/JobDirectory.js";

const output = configLoader.load("DIRECTORY", "output")
const docId = `resume-test-${process.pid}-${Date.now()}`
const jobDir = jobDirectory.dir(output, docId)

afterAll(() => {
    if (fs.existsSync(jobDir)) {
        fs.rmSync(jobDir, { recursive: true, force: true })
    }
})

describe("resume", () => {
    test("rejects a job directory outside the configured output", async () => {
        const outside = path.join(os.tmpdir(), `scribd-dl-outside-${process.pid}-${Date.now()}`)
        fs.mkdirSync(outside, { recursive: true })
        try {
            await expect(jobRunner.resume(outside)).rejects.toThrow("must live under the configured output")
        } finally {
            fs.rmSync(outside, { recursive: true, force: true })
        }
    })

    test("rejects a job directory without a manifest.json", async () => {
        await jobDirectory.create(output, docId)
        await expect(jobRunner.resume(jobDir)).rejects.toThrow("No manifest.json found")
    })

    test("accepts a complete manifest on the correct path", async () => {
        fs.mkdirSync(path.join(jobDir, "pages"), { recursive: true })
        fs.writeFileSync(path.join(jobDir, "manifest.json"), JSON.stringify({ total: 0 }))
        const collectSpy = jest.spyOn(jobRunner, "collect").mockResolvedValue({ total: 0, pages: [] })
        const assembleSpy = jest.spyOn(jobRunner, "assemble").mockResolvedValue(undefined)
        try {
            await jobRunner.resume(jobDir)
            expect(collectSpy).toHaveBeenCalled()
            expect(assembleSpy).toHaveBeenCalled()
        } finally {
            collectSpy.mockRestore()
            assembleSpy.mockRestore()
        }
    })
})