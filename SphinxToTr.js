"use strict"

const Fs = require('fs')
const Path = require('path')
const Yaml = require('js-yaml')
const Jsdom = require("jsdom")
const { InitializedSet, ArrayMap } = require('./lib/containers')
const ChattyResourceLoader = require('./lib/ChattyResourceLoader')
const { JSDOM } = Jsdom

// How long to wait for a doc to load. Increase when using WAIT_FOR.
const LOAD_TIMEOUT = 1000

// WAIT_FOR loads scripts and waits for the listed window variables to be
// initialize. Many scripts do not run in JSDOM so this is sensitive to JSDOM
// limitiations
const WAIT_FOR = [] // ['$']

// Debug by showing what pages are being loaded.
const CHATTY_LOADER = false

// Working class to translate Sphinx docs to W3C TR/ format
class SphinxToTr {
  constructor (path) {
    const parsed = Path.parse(path)

    // File path to Sphinx source
    this.relDir = parsed.dir

    // Sphinx index page
    this.startPage = parsed.name + parsed.ext

    // What document globals should be set in order to process doc
    this.waitFor = WAIT_FOR // hard-wired until creating real CLI app

    // Cache loaded pages, mostly so we don't have to load index.html again
    this.pageCache = new Map()
  }

  /** indexPage - Crawl through sphinx index page to number sections
   */
  async indexPage (
    // Which labels should not get numbers
    appendixLabels,

    // CSS selector for root of TOC
    selector = '.toctree-wrapper',

    // Sphinx index page
    page = this.startPage
  ) {
    const { dom, document, url, dir, find } = await this.loadPage(page, LOAD_TIMEOUT)

    const [primaryToc] = find(selector + ' > ul') // sphinx seems to have three unclassed <ul/>s
    const ret = new Map()
    visit(primaryToc, '')
    return ret

    function visit (ul, leader) {
      const numberableSections = SphinxToTr.childrenByName(ul, 'li')
            .filter( (elt) => appendixLabels.indexOf(elt.textContent) === -1 )
      numberableSections.forEach( (li, idx) => {
        const secNo = leader + (idx + 1)

        const az = SphinxToTr.childrenByName(li, 'a')
        if (az.length !== 1)
          throw new Error(`found ${az.length} <a/> elements in TOC entry ${li.outerHTML}`)
        const a = az[0]
        const urlStr = a.href
        if (!(urlStr.startsWith(dir)))
          throw new Error(`apparent href to doc outside TR/ tree <${urlStr}> in  ${li.outerHTML}`)
        const relStr = urlStr.substr(dir.length)

        // Return if this is an un-numbered TOC entry.
        if (appendixLabels.indexOf(a.textContent) !== -1)
          return

        // Renumber index entry.
        const linkText = SphinxToTr.addNumber(document, a, secNo, null)

        // Record name of this TOC entry.
        ret.set(relStr, { elt: li, secNo, linkText })

        // Don't bother writing; sidebar renumbering will write out all changes.

        // Renumber nested children.
        const ulz = SphinxToTr.childrenByName(li, 'ul')
        if (ulz.length > 1)
          throw new Error(`found ${ulz.length} <ul/> elements in TOC entry ${li.outerHTML}`)
        if (ulz.length === 1)
          visit(ulz[0], secNo + '.')
      })
    }
  }


  async updateFrontMatter (
    // Config strcuture for a W3C Respec doc
    respecConfig,

    // CSS selector for root of TOC
    selector = '[role=main] > div',

    // Sphinx index page
    page = this.startPage
  ) {
    const { dom, document, url, dir, find } = await this.loadPage(page, LOAD_TIMEOUT)

    if (typeof respecConfig === 'string') {
      const text = Fs.readFileSync(respecConfig, 'utf-8')
      respecConfig = respecConfig.endsWith('yaml')
        ? Yaml.load(text)
        : JSON.parse(text)
    }
    console.log(respecConfig)

    let date = new Date()
    const pubDate = new Date().toLocaleString('en-US', { dateStyle: 'medium' })
    const [block] = find(selector)
    SphinxToTr.childrenByClass(block, 'line-block').forEach( (line) => {
      const d1 = new Date(line.textContent)
      if (d1 !== 'Invalid Date')
        date = d1.toLocaleString('en-US', { dateStyle: 'medium' })
      line.remove()
    })
    const time = document.createElement('time')
    time.setAttribute('datetime', pubDate)
    time.classList.add('dt-updated')
    const span = document.createElement('span')
    span.textContent = 'W3C Working Draft'
    span.append(time)

    const h1 = SphinxToTr.childrenByName(block, 'h1')[0]
    h1.classList.add('p-name', 'no-ref')
    h1.id = 'title'
    const h2 = document.createElement('h2')
    h2.append(span)
    h2.id = 'profile-and-date'
    block.insertBefore(h2, h1.nextElementSibling)

    console.log(block.outerHTML)
  }

  /** copyRecursively - Recursively copy each referenced doc
   * @returns - i dunno, but it's not useful yet.
   */
  async copyRecursively (
    numberedSections,
    outDir,
    page = this.startPage,
    seen = new InitializedSet(page)
  ) {
    const { dom, document, url, dir, find } = await this.loadPage(page, LOAD_TIMEOUT)

    // List all hrefs just as an FYI.
    const urlStrToElements =
          SphinxToTr.localHrefs(find('a'), dir)
          .reduce( (acc, [urlStr, elt]) => acc.set(urlStr, elt), new ArrayMap())
    urlStrToElements.delete('')
    console.log(`${page} has ${urlStrToElements.total} references to ${urlStrToElements.size} descendants of ${dir}`)

    // add section numbers to sidebar
    const az = SphinxToTr.localHrefs(find('[role=navigation] a'), dir)
    const ret = await Promise.all(az.reduce((acc, [relUrl, a]) => {
      if (!numberedSections.has(relUrl)) {
        // console.warn(`skipping un-numbered reference in ${a.outerHTML}`)
        return acc
      }
      const entry = numberedSections.get(relUrl)

      // Renumber index entry.
      SphinxToTr.addNumber(document, a, entry.secNo, entry.linkText)
      acc.push(Promise.resolve({page, relUrl, entry}))

      if (!seen.has(relUrl)) {
        seen.add(relUrl)
        acc.push(this.copyRecursively(numberedSections, outDir, relUrl, seen))
      }

      return acc
    }, []))

    // write out the file
    const outFilePath = Path.join(outDir, page)
    Fs.mkdirSync(Path.dirname(outFilePath), {recursive: true})
    const text = document.documentElement.outerHTML
    Fs.writeFileSync(outFilePath, text, {encoding: 'utf-8'})
    console.log(`${outFilePath}: ${text.length} chars`)

    return ret

    function ensureDirectoryExistence(filePath) {
      var dirname = Path.dirname(filePath);
      if (Fs.existsSync(dirname)) {
        return true;
      }
      ensureDirectoryExistence(dirname);
      Fs.mkdirSync(dirname);
    }
  }

  /**
   */
  async loadPage (page, timeout) {
    if (this.pageCache.has(page))
      return this.pageCache.get(page)

    // calculate relative path and effective URL
    const path = Path.join(__dirname, this.relDir, page)
    const url = new URL('file://' + path)
    const dir = url.href.substr(0, url.href.length - page.length) // new URL('..', url).href

    const dom = new JSDOM(Fs.readFileSync(path, 'utf8'), Object.assign({
      url: url
    }, this.waitFor.length ? {
      runScripts: "dangerously",
      resources: CHATTY_LOADER
        ? new ChattyResourceLoader()
        : "usable",
    } : {}))
    const document = dom.window.document

    // work around bug in MathJax appVersion parser
    // dom.window.navigator.appVersion = dom.window.navigator.userAgent

    // Load the page with a timeout
    let timer = null;
    await Promise.race([
      new Promise((res, rej) => {
        timer = setTimeout(() => {
          timer = null
          rej(`timeout of ${timeout} exceeded when fetching ${page}`)
        }, timeout)
      }),
      new Promise((res, rej) => {
        dom.window.document.addEventListener("DOMContentLoaded", (evt) => {
          if (timer) {
            clearTimeout(timer)
            res()
          } else {
            rej('timeout')
          }
        })
      })
    ])

    this.waitFor.forEach( (wf) => {
      if (!(wf in dom.window))
        throw new Error(`${wf} failed to load`)
    })

    // convenience function find to query DOM
    const find =
          // (selectors, from) => (from ? dom.window.$(from).find(selectors) : dom.window.$(selectors)).get() // jQuery
          (selectors, from) => [...(from || document).querySelectorAll(selectors)] // DOM

    // cache and return
    const ret = { dom, path, url, dir, document, find }
    this.pageCache.set(page, ret)
    return ret

  }

  // Static helpers

  // Create a span element with given text and classes
  static span (document, text, classes) {
    const span = document.createElement('span')
    span.textContent = text
    classes.forEach( (c) => span.classList.add(c) )
    return span
  }

  static addNumber (document, a, secNo, linkText) {
    if (linkText) {
      if (linkText !== a.textContent)
        throw new Error(`expected link to ${a.href} to have link text "${linkText}" - saw ${a.textContent}`)
    } else {
      linkText = a.textContent
    }
    a.textContent = ''
    a.appendChild(SphinxToTr.span(document, secNo, ['secno']))
    a.appendChild(document.createTextNode(' '))
    a.appendChild(SphinxToTr.span(document, linkText, ['content']))
    return linkText
  }

  static localHrefs (elts, dir) {
    return elts
      .map( (elt) => [SphinxToTr.noHash(elt.href), elt] )
      .filter( ([urlStr, elt]) => [urlStr.startsWith(dir), elt] )
      .map( ([urlStr, elt]) => [urlStr.substr(dir.length), elt] )
  }

  // strip hash off URL
  static noHash (urlStr) {
    const u = new URL(urlStr)
    u.hash = ''
    return u.href
  }

  // Manually walk children because there's no support for
  // :scope and I don't know how to find Element.prototype
  // needed for <https://stackoverflow.com/a/17989803/1243605>.
  // const az = find(':scope > a', li)
  static childrenByName (parent, localName) {
    return [...parent.children].filter( (elt) => elt.localName === localName )
  }

  static childrenByClass (parent, cls) {
    return [...parent.children].filter( (elt) => elt.classList.contains(cls) )
  }
}

module.exports = SphinxToTr