/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Assert, AsyncUtils, FileUtils } from '@ironfish/sdk'
import { CliUx, Flags } from '@oclif/core'
import { spawn } from 'child_process'
import crypto from 'crypto'
import fsAsync from 'fs/promises'
import os from 'os'
import path from 'path'
import { IronfishCommand } from '../../command'
import { RemoteFlags } from '../../flags'
import { ProgressBar } from '../../types'

export default class CreateSnapshot extends IronfishCommand {
  static hidden = true

  static description = `Upload chain snapshot to a public bucket`

  static flags = {
    ...RemoteFlags,
    bucket: Flags.string({
      char: 'e',
      parse: (input: string) => Promise.resolve(input.trim()),
      required: false,
      description: 'Bucket URL to upload snapshot to',
    }),
    path: Flags.string({
      char: 'p',
      parse: (input: string): Promise<string> => Promise.resolve(input.trim()),
      required: false,
      description: 'The path where the snapshot should be saved',
    }),
    maxBlocksPerChunk: Flags.integer({
      char: 'm',
      required: false,
      default: isNaN(Number(process.env.MAX_BLOCKS_PER_SNAPSHOT_CHUNK))
        ? 1000
        : Number(process.env.MAX_BLOCKS_PER_SNAPSHOT_CHUNK),
      description: 'The max number of blocks per file in the zipped snapshot',
    }),
  }

  async start(): Promise<void> {
    const { flags } = await this.parse(CreateSnapshot)

    const bucket = (flags.bucket || process.env.IRONFISH_SNAPSHOT_BUCKET || '').trim()

    let exportDir

    if (flags.path) {
      exportDir = this.sdk.fileSystem.resolve(flags.path)
    } else {
      try {
        exportDir = await fsAsync.mkdtemp(`${os.tmpdir()}${path.sep}`)
      } catch (err) {
        this.log(`Could not create temp folder for snapshot generation`)
        this.exit(1)
      }
    }
    Assert.isNotUndefined(exportDir)

    const blockExportPath = this.sdk.fileSystem.join(exportDir, 'blocks')
    await this.sdk.fileSystem.mkdir(blockExportPath, { recursive: true })

    this.log('Connecting to node...')

    const client = await this.sdk.connectRpc()

    const response = client.snapshotChainStream({
      maxBlocksPerChunk: flags.maxBlocksPerChunk,
    })

    const { start, stop } = await AsyncUtils.first(response.contentStream())
    this.log(`Retrieving blocks from ${start} -> ${stop} for snapshot generation`)

    const progress = CliUx.ux.progress({
      format: 'Retrieving blocks: [{bar}] {value}/{total} {percentage}% | ETA: {eta}s',
    }) as ProgressBar

    progress.start(stop - start + 1, 0)

    for await (const result of response.contentStream()) {
      if (result.buffer && result.seq) {
        const blockFilePath = this.sdk.fileSystem.join(blockExportPath, `${result.seq}`)
        await fsAsync.writeFile(blockFilePath, Buffer.from(result.buffer))
        progress.update(result.seq || 0)
      }
    }

    progress.stop()

    const timestamp = Date.now()

    const snapshotFileName = `ironfish_snapshot_${timestamp}.tar.gz`
    const snapshotPath = this.sdk.fileSystem.join(exportDir, snapshotFileName)

    this.log(`Zipping\n    SRC ${blockExportPath}\n    DST ${snapshotPath}\n`)
    CliUx.ux.action.start(`Zipping ${blockExportPath}`)
    await this.zipDir(blockExportPath, snapshotPath)
    const stat = await fsAsync.stat(snapshotPath)
    const fileSize = stat.size
    CliUx.ux.action.stop(`done (${FileUtils.formatFileSize(fileSize)})`)

    const hasher = crypto.createHash('sha256')
    const fileHandle = await fsAsync.open(snapshotPath, 'r')
    const stream = fileHandle.createReadStream()

    CliUx.ux.action.start(`Creating checksum for ${snapshotPath}`)
    for await (const data of stream) {
      hasher.update(data)
    }
    const checksum = hasher.digest().toString('hex')
    CliUx.ux.action.stop(`done (${checksum})`)

    if (bucket) {
      const blockHeight = stop

      CliUx.ux.action.start(`Uploading to ${bucket}`)
      await this.uploadToBucket(snapshotPath, bucket, 'application/x-compressed-tar')
      CliUx.ux.action.stop(`done`)

      const manifestPath = path.join(exportDir, 'manifest.json')

      await fsAsync
        .writeFile(
          manifestPath,
          JSON.stringify({
            block_height: blockHeight,
            checksum,
            file_name: snapshotFileName,
            file_size: fileSize,
            timestamp,
          }),
        )
        .then(async () => {
          CliUx.ux.action.start(`Uploading latest snapshot information to ${bucket}`)
          await this.uploadToBucket(manifestPath, bucket, 'application/json')
          CliUx.ux.action.stop(`done`)
        })
    }
  }

  zipDir(source: string, dest: string, excludes: string[] = []): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const sourceDir = path.dirname(source)
      const sourceFile = path.basename(source)

      const args = ['-zcf', dest, '-C', sourceDir, sourceFile]

      for (const exclude of excludes) {
        args.unshift(exclude)
        args.unshift('--exclude')
      }

      const process = spawn('tar', args)
      process.on('exit', (code) => resolve(code))
      process.on('close', (code) => resolve(code))
      process.on('error', (error) => reject(error))
    })
  }

  uploadToBucket(dest: string, host: string, contentType: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const date = new Date().toISOString()
      const file = path.basename(dest)
      const acl = 'bucket-owner-full-control'

      const process = spawn(
        `curl`,
        [
          '-X',
          `PUT`,
          `-T`,
          `${dest}`,
          `-H`,
          `Host: ${host}`,
          `-H`,
          `Date: ${date}`,
          `-H`,
          `Content-Type: ${contentType}`,
          `-H`,
          `x-amz-acl: ${acl}`,
          `https://${host}/${file}`,
        ],
        { stdio: 'inherit' },
      )

      process.on('message', (m) => this.log(String(m)))
      process.on('exit', (code) => resolve(code))
      process.on('error', (error) => reject(error))
    })
  }
}
