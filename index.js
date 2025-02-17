const resolveBitPath = require('@web4/resolve-bit-path')
const Headers = require('fetch-headers')
const mime = require('mime/lite')
const SDK = require('@web4/sdk')
const parseRange = require('range-parser')
const makeDir = require('make-dir')
const { Readable } = require('streamx')
const makeFetch = require('make-fetch')
const { EventIterator } = require('event-iterator')

const DEFAULT_TIMEOUT = 5000

const NUMBER_REGEX = /^\d+$/
const PROTOCOL_REGEX = /^\w+:\/\//
const NOT_WRITABLE_ERROR = 'Archive not writable'

const READABLE_ALLOW = ['GET', 'HEAD']
const WRITABLE_ALLOW = ['PUT', 'POST', 'DELETE']
const ALL_ALLOW = READABLE_ALLOW.concat(WRITABLE_ALLOW)

const SPECIAL_FOLDER = '/$/'
const TAGS_FOLDER_NAME = 'tags/'
const TAGS_FOLDER = SPECIAL_FOLDER + TAGS_FOLDER_NAME
const EXTENSIONS_FOLDER_NAME = 'extensions/'
const EXTENSIONS_FOLDER = SPECIAL_FOLDER + EXTENSIONS_FOLDER_NAME
const EXTENSION_EVENT = 'extension-message'
const PEER_OPEN = 'peer-open'
const PEER_REMOVE = 'peer-remove'

// TODO: Add caching support
const { resolveURL: DEFAULT_RESOLVE_URL } = require('@web4/dns')

module.exports = function makeBitFetch (opts = {}) {
  let {
    Bitdrive,
    resolveURL = DEFAULT_RESOLVE_URL,
    base,
    timeout = DEFAULT_TIMEOUT,
    writable = false
  } = opts

  let sdk = null
  let gettingSDK = null
  let onClose = async () => undefined

  const isSourceBit = base && base.startsWith('bit://')

  const fetch = makeFetch(bitFetch)

  fetch.close = () => onClose()

  function getExtension (archive, name) {
    const existing = archive.metadata.extensions.get(name)
    if (existing) return existing

    const extension = archive.registerExtension(name, {
      encoding: 'utf8',
      onmessage: (content, peer) => {
        archive.emit(EXTENSION_EVENT, name, content, peer)
      }
    })

    return extension
  }

  function getExtensionPeers (archive, name) {
    // List peers with this extension
    const allPeers = archive.peers
    return allPeers.filter((peer) => {
      const { remoteExtensions } = peer

      if (!remoteExtensions) return false

      const { names } = remoteExtensions

      if (!names) return false

      return names.includes(name)
    })
  }

  function listExtensionNames (archive) {
    return archive.metadata.extensions.names()
  }

  async function loadArchive (key) {
    const Bitdrive = await getBitdrive()
    return Bitdrive(key)
  }

  return fetch

  async function bitFetch ({ url, headers: rawHeaders, method, signal, body }) {
    const isBitURL = url.startsWith('bit://')
    const urlHasProtocol = url.match(PROTOCOL_REGEX)

    const shouldIntercept = isBitURL || (!urlHasProtocol && isSourceBit)

    if (!shouldIntercept) throw new Error('Invalid protocol, must be bit://')

    const headers = new Headers(rawHeaders || {})

    const responseHeaders = {}
    responseHeaders['Access-Control-Allow-Origin'] = '*'
    responseHeaders['Allow-CSP-From'] = '*'
    responseHeaders['Access-Control-Allow-Headers'] = '*'

    try {
      let { pathname: path, key, version, searchParams } = parseBitURL(url)
      if (!path) path = '/'
      if (!path.startsWith('/')) path = '/' + path

      try {
        const resolvedURL = await resolveURL(`bit://${key}`)
        key = resolvedURL.hostname
      } catch (e) {
        // Probably a domain that couldn't resolve
        if (key.includes('.')) throw e
      }

      let archive = await loadArchive(key)

      if (!archive) {
        return {
          statusCode: 404,
          headers: responseHeaders,
          data: intoAsyncIterable('Unknown drive')
        }
      }

      await archive.ready()

      if (!archive.version) {
        if (!archive.peers.length) {
          await new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('Timed out looking for peers')), timeout)
            archive.once('peer-open', resolve)
          })
        }
        await new Promise((resolve, reject) => {
          archive.metadata.update({ ifAvailable: true }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }

      if (version) {
        if (NUMBER_REGEX.test(version)) {
          archive = await archive.checkout(version)
        } else {
          archive = await archive.checkout(await archive.getTaggedVersion(version))
        }
        await archive.ready()
      }

      const canonical = `bit://${archive.key.toString('hex')}${path || ''}`
      responseHeaders.Link = `<${canonical}>; rel="canonical"`

      const isWritable = writable && archive.writable
      const allowHeaders = isWritable ? ALL_ALLOW : READABLE_ALLOW
      responseHeaders.Allow = allowHeaders.join(', ')

      // We can say the file hasn't changed if the drive version hasn't changed
      responseHeaders.ETag = `"${archive.version}"`

      if (path.startsWith(SPECIAL_FOLDER)) {
        if (path === SPECIAL_FOLDER) {
          const files = [
            TAGS_FOLDER_NAME,
            EXTENSIONS_FOLDER_NAME
          ]

          const data = renderFiles(headers, responseHeaders, url, path, files)
          if (method === 'HEAD') {
            return {
              statusCode: 204,
              headers: responseHeaders,
              data: intoAsyncIterable('')
            }
          } else {
            return {
              statusCode: 200,
              headers: responseHeaders,
              data
            }
          }
        } else if (path.startsWith(TAGS_FOLDER)) {
          if (method === 'GET') {
            if (path === TAGS_FOLDER) {
              responseHeaders['x-is-directory'] = 'true'
              const tags = await archive.getAllTags()
              const tagsObject = Object.fromEntries(tags)
              const json = JSON.stringify(tagsObject, null, '\t')

              responseHeaders['Content-Type'] = 'application/json; charset=utf-8'

              return {
                statusCode: 200,
                headers: responseHeaders,
                data: intoAsyncIterable(json)
              }
            } else {
              const tagName = path.slice(TAGS_FOLDER.length)
              try {
                const tagVersion = await archive.getTaggedVersion(tagName)

                return {
                  statusCode: 200,
                  headers: responseHeaders,
                  data: intoAsyncIterable(`${tagVersion}`)
                }
              } catch {
                return {
                  statusCode: 404,
                  headers: responseHeaders,
                  data: intoAsyncIterable('Tag Not Found')
                }
              }
            }
          } else if (method === 'DELETE') {
            checkWritable(archive)
            const tagName = path.slice(TAGS_FOLDER.length)
            await archive.deleteTag(tagName || version)
            responseHeaders.ETag = `"${archive.version}"`

            return {
              statusCode: 200,
              headers: responseHeaders,
              data: intoAsyncIterable('')
            }
          } else if (method === 'PUT') {
            checkWritable(archive)
            const tagName = path.slice(TAGS_FOLDER.length)
            const tagVersion = archive.version

            await archive.createTag(tagName, tagVersion)
            responseHeaders['Content-Type'] = 'text/plain; charset=utf-8'
            responseHeaders.ETag = `"${archive.version}"`

            return {
              statusCode: 200,
              headers: responseHeaders,
              data: intoAsyncIterable(`${tagVersion}`)
            }
          } else if (method === 'HEAD') {
            return {
              statusCode: 204,
              headers: responseHeaders,
              data: intoAsyncIterable('')
            }
          } else {
            return {
              statusCode: 405,
              headers: responseHeaders,
              data: intoAsyncIterable('Method Not Allowed')
            }
          }
        } else if (path.startsWith(EXTENSIONS_FOLDER)) {
          if (path === EXTENSIONS_FOLDER) {
            if (method === 'GET') {
              const accept = headers.get('Accept') || ''
              if (!accept.includes('text/event-stream')) {
                responseHeaders['x-is-directory'] = 'true'

                const extensions = listExtensionNames(archive)
                const data = renderFiles(headers, responseHeaders, url, path, extensions)

                return {
                  statusCode: 204,
                  headers: responseHeaders,
                  data
                }
              }

              const events = new EventIterator(({ push }) => {
                function onMessage (name, content, peer) {
                  const id = peer.remotePublicKey.toString('hex')
                  // TODO: Fancy verification on the `name`?
                  // Send each line of content separately on a `data` line
                  const data = content.split('\n').map((line) => `data:${line}\n`).join('')
                  push(`id:${id}\nevent:${name}\n${data}\n`)
                }
                function onPeerOpen (peer) {
                  const id = peer.remotePublicKey.toString('hex')
                  push(`id:${id}\nevent:${PEER_OPEN}\n\n`)
                }
                function onPeerRemove (peer) {
                  // Whatever, probably an uninitialized peer
                  if (!peer.remotePublicKey) return
                  const id = peer.remotePublicKey.toString('hex')
                  push(`id:${id}\nevent:${PEER_REMOVE}\n\n`)
                }
                archive.on(EXTENSION_EVENT, onMessage)
                archive.on(PEER_OPEN, onPeerOpen)
                archive.on(PEER_REMOVE, onPeerRemove)
                return () => {
                  archive.removeListener(EXTENSION_EVENT, onMessage)
                  archive.removeListener(PEER_OPEN, onPeerOpen)
                  archive.removeListener(PEER_REMOVE, onPeerRemove)
                }
              })

              responseHeaders['Content-Type'] = 'text/event-stream'

              return {
                statusCode: 200,
                headers: responseHeaders,
                data: events
              }
            } else {
              return {
                statusCode: 405,
                headers: responseHeaders,
                data: intoAsyncIterable('Method Not Allowed')
              }
            }
          } else {
            let extensionName = path.slice(EXTENSIONS_FOLDER.length)
            let extensionPeer = null
            if (extensionName.includes('/')) {
              const split = extensionName.split('/')
              extensionName = split[0]
              if (split[1]) extensionPeer = split[1]
            }
            if (method === 'POST') {
              const extension = getExtension(archive, extensionName)
              if (extensionPeer) {
                const peers = getExtensionPeers(archive, extensionName)
                const peer = peers.find(({ remotePublicKey }) => remotePublicKey.toString('hex') === extensionPeer)
                if (!peer) {
                  return {
                    statusCode: 404,
                    headers: responseHeaders,
                    data: intoAsyncIterable('Peer Not Found')
                  }
                }
                extension.send(await collect(body), peer)
              } else {
                extension.broadcast(await collect(body))
              }
              return {
                statusCode: 200,
                headers: responseHeaders,
                data: intoAsyncIterable('')
              }
            } else if (method === 'GET') {
              const accept = headers.get('Accept') || ''
              if (!accept.includes('text/event-stream')) {
                // Load up the extension into memory
                getExtension(archive, extensionName)

                const extensionPeers = getExtensionPeers(archive, extensionName)
                const finalPeers = formatPeers(extensionPeers)

                const json = JSON.stringify(finalPeers, null, '\t')

                return {
                  statusCode: 200,
                  header: responseHeaders,
                  data: intoAsyncIterable(json)
                }
              }
            } else {
              return {
                statusCode: 405,
                headers: responseHeaders,
                data: intoAsyncIterable('Method Not Allowed')
              }
            }
          }
        } else {
          return {
            statusCode: 404,
            headers: responseHeaders,
            data: intoAsyncIterable('Not Found')
          }
        }
      }

      if (method === 'PUT') {
        checkWritable(archive)
        if (path.endsWith('/')) {
          await makeDir(path, { fs: archive })
        } else {
          const parentDir = path.split('/').slice(0, -1).join('/')
          if (parentDir) {
            await makeDir(parentDir, { fs: archive })
          }

          const source = Readable.from(body)
          const destination = archive.createWriteStream(path)
          // The sink is needed because Bitdrive's write stream is duplex

          source.pipe(destination)

          await Promise.race([
            once(source, 'error'),
            once(destination, 'error'),
            once(source, 'end')
          ])
        }
        responseHeaders.ETag = `"${archive.version}"`

        return {
          statusCode: 200,
          headers: responseHeaders,
          data: intoAsyncIterable('')
        }
      } else if (method === 'DELETE') {
        if (headers.get('x-clear') === 'cache') {
          await archive.clear(path)
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable('')
          }
        } else {
          checkWritable(archive)

          const stats = await archive.stat(path)
          // Weird stuff happening up in here...
          const stat = Array.isArray(stats) ? stats[0] : stats

          if (stat.isDirectory()) {
            await archive.rmdir(path)
          } else {
            await archive.unlink(path)
          }
          responseHeaders.ETag = `"${archive.version}"`

          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable('')
          }
        }
      } else if ((method === 'GET') || (method === 'HEAD')) {
        if (method === 'GET' && headers.get('Accept') === 'text/event-stream') {
          const contentFeed = await archive.getContent()
          const events = new EventIterator(({ push, fail }) => {
            const watcher = archive.watch(path, () => {
              const event = 'change'
              const data = archive.version
              push({ event, data })
            })
            watcher.on('error', fail)
            function onDownloadMetadata (index) {
              const event = 'download'
              const source = archive.metadata.key.toString('hex')
              const data = { index, source }
              push({ event, data })
            }
            function onUploadMetadata (index) {
              const event = 'download'
              const source = archive.metadata.key.toString('hex')
              const data = { index, source }
              push({ event, data })
            }

            function onDownloadContent (index) {
              const event = 'download'
              const source = contentFeed.key.toString('hex')
              const data = { index, source }
              push({ event, data })
            }
            function onUploadContent (index) {
              const event = 'download'
              const source = contentFeed.key.toString('hex')
              const data = { index, source }
              push({ event, data })
            }

            // TODO: Filter out indexes that don't belong to files?

            archive.metadata.on('download', onDownloadMetadata)
            archive.metadata.on('upload', onUploadMetadata)
            contentFeed.on('download', onDownloadContent)
            contentFeed.on('upload', onUploadMetadata)
            return () => {
              watcher.destroy()
              archive.metadata.removeListener('download', onDownloadMetadata)
              archive.metadata.removeListener('upload', onUploadMetadata)
              contentFeed.removeListener('download', onDownloadContent)
              contentFeed.removeListener('upload', onUploadContent)
            }
          })
          async function * startReader () {
            for await (const { event, data } of events) {
              yield `event:${event}\ndata:${JSON.stringify(data)}\n\n`
            }
          }

          responseHeaders['Content-Type'] = 'text/event-stream'

          return {
            statusCode: 200,
            headers: responseHeaders,
            data: startReader()
          }
        }

        let stat = null
        let finalPath = path

        if (headers.get('x-download') === 'cache') {
          await archive.download(path)
        }

        // Legacy DNS spec from Bit protocol: https://github.com/datprotocol/DEPs/blob/master/proposals/0005-dns.md
        if (finalPath === '/.well-known/bit') {
          const { key } = archive
          const entry = `bit://${key.toString('hex')}\nttl=3600`
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable(entry)
          }
        }

        // New spec from bit-dns https://github.com/bitwebs/bit-dns
        if (finalPath === '/.well-known/bit') {
          const { key } = archive
          const entry = `bit://${key.toString('hex')}\nttl=3600`
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable(entry)
          }
        }
        try {
          if (searchParams.has('noResolve')) {
            const stats = await archive.stat(path)
            stat = stats[0]
          } else {
            const resolved = await resolveBitPath(archive, path)
            finalPath = resolved.path
            stat = resolved.stat
          }
        } catch (e) {
          responseHeaders['Content-Type'] = 'text/plain; charset=utf-8'
          return {
            statusCode: 404,
            headers: responseHeaders,
            data: intoAsyncIterable(e.stack)
          }
        }

        responseHeaders['Content-Type'] = getMimeType(finalPath)
        responseHeaders['Last-Modified'] = stat.mtime.toUTCString()

        let data = null
        const isRanged = headers.get('Range') || headers.get('range')
        let statusCode = 200

        if (stat.isDirectory()) {
          responseHeaders['x-is-directory'] = 'true'
          const stats = await archive.readdir(finalPath, { includeStats: true })
          const files = stats.map(({ stat, name }) => (stat.isDirectory() ? `${name}/` : name))

          // Add special directory
          if (finalPath === '/') files.unshift('$/')

          data = renderFiles(headers, responseHeaders, url, path, files)
        } else {
          responseHeaders['Accept-Ranges'] = 'bytes'

          try {
            const { blocks, downloadedBlocks } = await archive.stats(finalPath)
            responseHeaders['X-Blocks'] = `${blocks}`
            responseHeaders['X-Blocks-Downloaded'] = `${downloadedBlocks}`
          } catch (e) {
            // Don't worry about it, it's optional.
          }

          const { size } = stat
          responseHeaders['Content-Length'] = `${size}`

          if (isRanged) {
            const ranges = parseRange(size, isRanged)
            if (ranges && ranges.length && ranges.type === 'bytes') {
              statusCode = 206
              const [{ start, end }] = ranges
              const length = (end - start + 1)
              responseHeaders['Content-Length'] = `${length}`
              responseHeaders['Content-Range'] = `bytes ${start}-${end}/${size}`
              if (method !== 'HEAD') {
                data = archive.createReadStream(finalPath, {
                  start,
                  end
                })
              }
            } else {
              if (method !== 'HEAD') {
                data = archive.createReadStream(finalPath)
              }
            }
          } else if (method !== 'HEAD') {
            data = archive.createReadStream(finalPath)
          }
        }

        if (method === 'HEAD') {
          return {
            statusCode: 204,
            headers: responseHeaders,
            data: intoAsyncIterable('')
          }
        } else {
          return {
            statusCode,
            headers: responseHeaders,
            data
          }
        }
      } else {
        return {
          statusCode: 405,
          headers: responseHeaders,
          data: intoAsyncIterable('Method Not Allowed')
        }
      }
    } catch (e) {
      const isUnauthorized = (e.message === NOT_WRITABLE_ERROR)
      const statusCode = isUnauthorized ? 403 : 500
      const statusText = isUnauthorized ? 'Not Authorized' : 'Server Error'
      return {
        statusCode,
        statusText,
        headers: responseHeaders,
        data: intoAsyncIterable(e.stack)
      }
    }
  }

  function getBitdrive () {
    if (Bitdrive) return Bitdrive
    return getSDK().then(({ Bitdrive }) => Bitdrive)
  }

  function getSDK () {
    if (sdk) return Promise.resolve(sdk)
    if (gettingSDK) return gettingSDK
    gettingSDK = SDK(opts).then((gotSDK) => {
      sdk = gotSDK
      gettingSDK = null
      onClose = async () => sdk.close()
      Bitdrive = sdk.Bitdrive

      return sdk
    })

    return gettingSDK
  }

  function checkWritable (archive) {
    if (!writable) throw new Error(NOT_WRITABLE_ERROR)
    if (!archive.writable) {
      throw new Error(NOT_WRITABLE_ERROR)
    }
  }
}

function parseBitURL (url) {
  const parsed = new URL(url)
  let key = parsed.hostname
  let version = null
  if (key.includes('+')) [key, version] = key.split('+')

  parsed.key = key
  parsed.version = version

  return parsed
}

async function * intoAsyncIterable (data) {
  yield Buffer.from(data)
}

function getMimeType (path) {
  let mimeType = mime.getType(path) || 'text/plain; charset=utf-8'
  if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
  return mimeType
}

function renderDirectory (url, path, files) {
  return `<!DOCTYPE html>
<title>${url}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<h1>Index of ${path}</h1>
<ul>
  <li><a href="../">../</a></li>${files.map((file) => `
  <li><a href="${file}">./${file}</a></li>
`).join('')}
</ul>
`
}

function renderFiles (headers, responseHeaders, url, path, files) {
  if (headers.get('Accept') && headers.get('Accept').includes('text/html')) {
    const page = renderDirectory(url, path, files)
    responseHeaders['Content-Type'] = 'text/html; charset=utf-8'
    return intoAsyncIterable(page)
  } else {
    const json = JSON.stringify(files, null, '\t')
    responseHeaders['Content-Type'] = 'application/json; charset=utf-8'
    return intoAsyncIterable(json)
  }
}

function once (ee, name) {
  return new Promise((resolve, reject) => {
    const isError = name === 'error'
    const cb = isError ? reject : resolve
    ee.once(name, cb)
  })
}

async function collect (source) {
  let buffer = ''

  for await (const chunk of source) {
    buffer += chunk
  }

  return buffer
}

function formatPeers (peers) {
  return peers.map(({ remotePublicKey, remoteAddress, remoteType, stats }) => {
    return {
      remotePublicKey: remotePublicKey.toString('hex'),
      remoteType,
      remoteAddress,
      stats
    }
  })
}
