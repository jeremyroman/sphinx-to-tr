#!/usr/bin/env node
"use strict"

import SphinxToTr from '../SphinxToTr.mjs';
import Logger from '../lib/RespecLogger.js';

const DefaultOptions = {
  "timeout": 10,
  "use-local": false,
  "disable-sandbox": false,
  "devtools": false,
  "verbose": false
}

run(DefaultOptions)

async function run (opts) {
  if (process.argv.length < 3) {
    const exe = process.argv[1]
    fail(`Usage: ${exe} <sphinx-index-file> <respec-config-file> <out-directory> [non-numbered-section]...
${exe} ../../webassembly/spec/core/index.html 'Appendix' 'another Appendix'`, -1)
  }
  try {
    const [indexPath, respecFile, outDir, ...unnumberedLinkText] = process.argv.slice(2)
    const log = new Logger(opts.verbose);
    const translator = new SphinxToTr(indexPath)
    const toc = await translator.indexPage(unnumberedLinkText)
    const headMatter = await translator.updateFrontMatter(new URL(respecFile, `file://${process.cwd()}/`).href, {
        timeout: opts.timeout * 1000,
        useLocal: opts["use-local"],
        onError: log.error.bind(log),
        onWarning: log.warn.bind(log),
        onProgress: log.info.bind(log),
        disableSandbox: opts["disable-sandbox"],
        devtools: opts.devtools,
      })
    const copied = await translator.copyRecursively(headMatter, toc, outDir)
    // console.log(JSON.stringify(copied, null, 2))
  } catch (e) {
    fail(e, -1)
  }
}

function fail (message, code) {
  console.error(message)
  process.exit(code)
}