const path = require('path')
const MutableWebTorrent = require('mutable-webtorrent')
const fs = require('fs-extra')

const DEFAULT_SECRET_STORAGE = require('env-paths')('bt-sync').config
const SECRET_FILE_EXTENSION = '.key'
const BT_FILE = '.bt'
const BTPK_PREFIX = 'urn:btpk:'

module.exports = async ({ torrent, path, ...opts }) => {
  const btsync = new BtSync(opts)

  if (path || torrent) await btsync.sync(path, torrent)

  return btsync
}
class BtSync {
  constructor (opts) {
    this.opts = opts
    this.webtorrent = opts.webtorrent || new MutableWebTorrent(opts)
  }

  async sync (path, torrent) {
    if (torrent) await this.syncTo(torrent, path)
    else await this.syncFrom(path)

    return this
  }

  async syncFrom (path) {
    const { secretStorage = DEFAULT_SECRET_STORAGE } = this.opts

    // See if the folder has a `.bt` file
    if (await hasBTFile(path)) {
      const magnet = await loadBTFile(path)

      const parsed = new URL(magnet)

      const xs = parsed.searchParams.get('xs')

      // If it does, check if it's a mutable torrent
      const isMutableLink = xs && xs.startsWith(BTPK_PREFIX)

      // If it isn't sync the torrent to the local folder
      if (!isMutableLink) return this.syncTo(magnet, path)

      const publicKeyString = xs.slice(BTPK_PREFIX.length)

      // If it is, check if we have the private key for the mutable torrent
      // if we don't sync the torrent to the local folder
      if (!hasSecret(publicKeyString, secretStorage)) return this.syncTo(magnet, path)

      const secretKey = await loadSecret(publicKeyString, secretStorage)

      // If we do, update the mutable torrent to the folder
      await this.updateMutable(path, publicKeyString, secretKey)
    } else {
      // If there's no .bt file, create a mutable torrent
      await this.createMutable(path)
    }
  }

  async syncTo (torrentId, path) {
    // Resolve torrent to either a file, or magnet or whatever
    const torrent = await new Promise((resolve) => {
      this.webtorrent.add(torrentId, { path }, resolve)
    })

    let magnet = torrent.magnetURI
    if (torrent.publicKey) {
      const publicKeyString = torrent.publicKey.toString('hex')
      magnet = `magnet:?xs=${BTPK_PREFIX}${publicKeyString}`
    }

    // Write the torrent info to a `.bt` file which has a magnet link
    await saveBTFile(path, magnet)

    // Start syncing the folder to the torrent
    // Output progress to the CLI
  }

  async createMutable (path) {
    let { secretKey, publicKey } = this.opts
    const { seed, secretStorage = DEFAULT_SECRET_STORAGE } = this.opts
    // generate a keypair, save the private key, generate the .bt file, and re sync

    if (secretKey && publicKey) {
      // Woot, I guess we'll use these?
    } else {
      // Generate keypair
      const pair = this.webtorrent.createKeypair(seed)
      secretKey = pair.secretKey
      publicKey = pair.publicKey
    }

    await saveSecret(publicKey, secretKey, secretStorage)

    const publicKeyString = publicKey.toString('hex')

    const magnet = `magnet:?xs=${BTPK_PREFIX}${publicKeyString}`

    await saveBTFile(path, magnet)

    await this.updateMutable(path, publicKey, secretKey)
  }

  async updateMutable (path, publicKey, secretKey) {
    const torrent = await new Promise((resolve) => {
      this.webtorrent.seed(path, resolve)
    })

    const { infoHash } = torrent

    this.webtorrent.publish(publicKey, secretKey, infoHash)
  }
}

async function hasBTFile (location) {
  const fileLocation = btLocation(location)

  return fs.pathExists(fileLocation)
}

async function loadBTFile (location) {
  const fileLocation = btLocation(location)

  return fs.readFile(fileLocation, 'utf8')
}

async function saveBTFile (location, magnet) {
  const fileLocation = btLocation(location)

  return fs.writeFile(fileLocation, magnet)
}

function btLocation (location) {
  return path.join(location, BT_FILE)
}

async function hasSecret (publicKey, secretStorage) {
// Check whether the secret key file exists for the given public key
  const location = secretLocation(publicKey, secretStorage)

  return fs.pathExists(location)
}

async function saveSecret (publicKey, secretKey, secretStorage) {
// Save the secret key to the secret storage
  const location = secretLocation(publicKey, secretStorage)

  return fs.writeFile(location, secretKey)
}

async function loadSecret (publicKey, secretStorage) {
  const location = secretLocation(publicKey, secretStorage)

  return fs.readFile(location)
}

function secretLocation (publicKey, secretStorage) {
  return path.join(secretStorage, publicKey.toString('hex') + SECRET_FILE_EXTENSION)
}