# unichain-fetch

Implementation of Fetch that uses the Web4 SDK for loading p2p content

`npm install --save @web4/unichain-fetch`

```javascript
const fetch = require('@web4/unichain-fetch')()

const someURL = `bit://social.x`

const response = await fetch(`${someURL}/index.json`)

const json = await response.json()

console.log(json)
```

You can also use the bundled CLI

```
npm i -g @web4unichain-fetch

unichain-fetch bit://somethingorother

# Or

npx unichain-fetch bit://somethingorother
```

## API

### `makeFetch({Bitdrive, resolveURL, base, session, writable}) => fetch()`

Creates a unichain-fetch instance.

The `base` parameter can be used to specify what the base URL is for relative paths like `fetch('./bit.json')`.

You can pass in options for the [Web4 SDK](https://github.com/bitwebs/web4js) to have it be auto-created,
or you can pass in both a function matching  `const archive = Bitdrive(key)` and a `const resolved = await resolveName(url)` function (where `resolved` is an instance of URL, uses bit-dns by default).

Set `session` to your Electron session if you want to enable setting the `body` of fetch requests to Electron's [UploadData](https://www.electronjs.org/docs/api/structures/upload-data) API in their protocol handlers.

If you don't want to allow write access to archives, pass in `writable: false`.

Typically, you don't need to pass in any of these and they're there for more advanced users.

After you've created it, `fetch` will be have like it does in [browsers](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API).

### `await fetch.close()`

Closes resources for the Web4 SDK. This does nothing if you specified the Bitdrive and `resolveName` options.

### Common Headers

Each response will contain a header for the canonical URL represented as a `Link` header with `rel=canonical`.

Each response will also contain the `Allow` header of all the methods currently allowed. If the archive is writable, this will contain `PUT`.

There is also an `ETag` header which will be a JSON string containging the drive's current `version`. This will change only when the drive has gotten an update of some sort and is monotonically incrementing.

### `fetch('bit://NAME/example.txt', {method: 'GET'})`

This will attempt to load `example.txt` from the archive labeled by `NAME`.

It will also load `index.html` files automatically for a folder.
You can find the details about how resolution works in the [resolve-bit-path](https://github.com/bitwebs/resolve-bit-path/blob/master/index.js#L3) module.

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

The response headers will contain `X-Blocks` for the number of blocks of data this file represents on disk, and `X-Blocks-Downloaded` which is the number of blocks from this file that have been downloaded locally.

### `fetch('bit://NAME/.well-known/bit', {method: 'GET'})`

This is used by the @web4/bit-dns module for resoving dns domains to `bit://` URLs.

This will return some text which will have a `bit://` URL of your archive, followed by a newline and a TTL for the DNS record.

### `fetch('bit://NAME/example/', {method: 'GET'})`

When doing a `GET` on a directory, you will get a directory listing.

By default it will return a JSON array of files and folders in that directory.

You can differentiate a folder from files by the fact that it ends with a `/`.

You can set the `Accept` header to `text/html` in order to have it return a basic HTML page with links to files and folders in that directory.

e.g.

```json
["example.txt", "posts/", "example2.md"]
```

Files in the directory will be listed under their name, sub-directories will have a `/` appended to them.

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

### `fetch('bit://NAME/example/?noResolve', {method: 'GET'})`

Adding `?noResolve` to a URL will prevent resolving `index.html` files and will attempt to load the path as is.
This can be useful for list files in a directory that would normally render as a page.

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

The response headers will contain `X-Blocks` for the number of blocks of data this file represents on disk, and `X-Blocks-Downloaded` which is the number of blocks from this file that have been downloaded locally.

### `fetch('bit://NAME/', {headers: {'Accept': 'text/event-stream'}})`

Using the `text/event-stream` content type in the `Accept` header will get back an event stream full of `change` events for every time a file at that path changes.

This can be useful if you want to trigger a download every time a file changes.
The `data` for the event will contain the version at the time of the change.

This stream of data can be used with the `EventSource` in browsers.

Currently there's no way to watch for changes to specific files, so that should be handled at the application level.

You can also watch for the `download` and `upload` events which will be emitted whenever you download or upload blocks from the bitdrive.

The `data` for the event will contain a JSON encoded object with the `index` of the block, and the `source` which is the public key of the unichain (either the metadata of the bitdrive, or the content feed).

### `fetch('bit://NAME/example.txt', {method: 'PUT', body: 'Hello World'})`

You can add files to archives using a `PUT` method along with a `body`.

The `body` can be either a `String`, an `ArrayBuffer`, a `Blob`, a WHATWG `ReadableStream`, a Node.js `Stream`, or electron's [UploadData](https://www.electronjs.org/docs/api/structures/upload-data) object (make sure to specify the `session` argument in the `makeFetch` function for electron support).

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

Your `NAME` will likely be a `name` in most cases to ensure you have a writeable archive.

### `fetch('bit://NAME/example.txt', {method: 'DELETE'})`

You can delete a file in an archive by using the `DELETE` method.

You cannot delete directories if they are not empty.

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

### `fetch('bit://NAME/example.txt', {method: 'GET', headers: {'x-download': 'cache'}})`

You can download a file or an entire folder to the local cache using the `x-download` header set to `cache` in a `GET` request.

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

You can use `/` for the path to download the entire contents

### `fetch('bit://NAME/example.txt', {method: 'DELETE', headers: {'x-clear': 'cache'}})`

You can clear the data stored in the local cache for a file or folder using the `x-clear` header set to `cache` in a `DELETE` request..

This is like the opposite of using `x-download` to download data.

This does not delete data, it only deletes the cached data from disk.

`NAME` can either be the 64 character hex key for an archive, a domain to parse with [@web4/bit-dns](https://www.npmjs.com/package/@web4/bit-dns), or a name for an archive which allows you to write to it.

You can use `/` for the path to clear all data for the archive.

### `fetch('bit://NAME/$/tags/TAG_NAME', {method: 'PUT'})`

You can add a tag a version of the archive with a human readable name (like SPAGHETTI), in the example represented as `tagName` by doing a PUT into the special `/$/tags/` folder.

Afterwards you can load the archive at that given version with `bit://NAME+TAG_NAME`.

E.g.

`PUT bit://123kjh213kjh123/$/tags/v4.20`
`GET bit://123kjh213kjh123+v4.20/example.txt`

### `fetch('bit://NAME/$/tags/', {method: 'GET'})`

You can get a list of all tags by doing a `GET` on the `/$/tags/` folder.

The response will be a JSON object which maps tag names to archive versions.

Use `await response.json()` to get the data out.

e.g.

```json
{
  "tagOne": 1,
  "example": 100000
}
```

### `fetch('bit://NAME/$/tags/TAG_NAME', {method: 'DELETE'})`

You can delete a given tag with the `DELETE` method on a name within the special `$/tags/` folder.

Specify the tag you want in the URL, and it'll be removed from the tags list.

### `fetch('bit://NAME/$/extensions/')`

You can list the current [unichain extensions](https://github.com/unichain-protocol/unichain#ext--feedregisterextensionname-handlers) that are enabled by doing a `GET` on the `/$/extensions/` directory.

This will give you a directory listing with the names of all the extensions.

### `fetch('bit://NAME/$/extensions/EXTENSION_NAME')`

You can list the peers that you are replication with which have registered this extension by doing a `GET` to the directory for the extension.

This is also how you can register an extension that hasn't been registered yet.

The list will be a JSON array with objects that contain the fields `remotePublicKey`, `remoteAddress`, `remoteType`, and `stats`

### `fetch('bit://NAME/$/extensions/', {headers: {'Accept': 'text/event-stream'}})`

Using the `text/event-stream` content type in the `Accept` header will get back an event stream with the extension events.

The `event` will be the name of the extension you got the data for, the `id` (accessible by `e.lastEventId` in EventSource) will be set to the ID of the peer that sent it.

Only extension messages that have been queried before via a `GET` to the EXTENSION_NAME will be visible in this stream.

There are also two special events: `peer-open` which gets emitted whena new peer has connected, and `peer-remove` which gets emitted when an existing peer disconnects.

### `fetch('bit://NAME/$/extensions/EXTENSION_NAME', {method: 'POST', body: 'Example'})`

You can broadcast an extension message to all peers that are replicating that extension type with a `POST` to the extension's URL.

The `body` of the request will be used as the payload. Please note that only utf8 encoded text is currently supported due to limitations of the event-stream encoding.

### `fetch('bit://NAME/$/extensions/EXTENSION_NAME/REMOTE_PUBLIC_KEY', {method: 'POST', body: 'Example'})`

You can send an extension message to a specific peer by doing a `POST` to the extension with their remote public key ID.

The `body` of the request will be used as the payload. Please note that only utf8 encoded text is currently supported due to limitations of the event-stream encoding.

