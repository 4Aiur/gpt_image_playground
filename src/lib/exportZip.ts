import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import type { AgentConversation, AppSettings, ExportData, FavoriteCollection, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { bytesToDataUrl, dataUrlToBytes } from './dataUrl'
import { getNumberedFileNameBase, sanitizeFileNamePart } from './exportFileName'

type ZipFiles = Record<string, Uint8Array | [Uint8Array, { mtime: Date }]>

const MAX_EXPORT_BLOB_BYTES = 2_147_483_647
const EXPORT_BLOB_CHUNK_BYTES = 512 * 1024 * 1024

export interface BuildExportZipOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

export interface BuildExportZipParams {
  options: BuildExportZipOptions
  exportedAt: number
  settings: AppSettings
  tasks: TaskRecord[]
  images: StoredImage[]
  thumbnailsByImageId: Map<string, StoredImageThumbnail>
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  agentConversations: AgentConversation[]
}

export interface ExportZipContents {
  manifest: ExportData
  files: Record<string, Uint8Array>
}

export interface ExportZipPart {
  fileName: string
  manifest: ExportData
  bytes: Uint8Array
}

export function buildExportZip(params: BuildExportZipParams) {
  const exportedAtDate = new Date(params.exportedAt)
  const imageCreatedAtFallback = getImageCreatedAtFallback(params.options.exportTasks ? params.tasks : [])
  const imageFileNameBases = getImageFileNameBases(params.options.exportTasks ? params.tasks : [])
  const imageFiles: ExportData['imageFiles'] = {}
  const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
  const zipFiles: ZipFiles = {}
  const usedImagePaths = new Set<string>()

  if (params.options.exportTasks) {
    for (const img of params.images) {
      const { ext, bytes } = dataUrlToBytes(img.dataUrl)
      const path = getUniqueImagePath(imageFileNameBases.get(img.id) || `image-${img.id}`, ext, usedImagePaths)
      const pathBase = path.slice('images/'.length, -(ext.length + 1))
      const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? params.exportedAt
      imageFiles[img.id] = {
        path,
        createdAt,
        source: img.source,
        width: img.width,
        height: img.height,
      }
      zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]

      const thumbnail = params.thumbnailsByImageId.get(img.id)
      if (thumbnail?.thumbnailDataUrl) {
        const { ext: thumbnailExt, bytes: thumbnailBytes } = dataUrlToBytes(thumbnail.thumbnailDataUrl)
        const thumbnailPath = `thumbnails/${pathBase}.${thumbnailExt}`
        imageFiles[img.id].width = imageFiles[img.id].width ?? thumbnail.width
        imageFiles[img.id].height = imageFiles[img.id].height ?? thumbnail.height
        thumbnailFiles[img.id] = {
          path: thumbnailPath,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: thumbnail.thumbnailVersion,
        }
        zipFiles[thumbnailPath] = [thumbnailBytes, { mtime: new Date(createdAt) }]
      }
    }
  }

  const manifest: ExportData = {
    version: 3,
    exportedAt: exportedAtDate.toISOString(),
  }

  if (params.options.exportConfig) manifest.settings = params.settings
  if (params.options.exportTasks) {
    manifest.tasks = params.tasks
    manifest.favoriteCollections = params.favoriteCollections
    manifest.defaultFavoriteCollectionId = params.defaultFavoriteCollectionId
    manifest.agentConversations = params.agentConversations
    manifest.imageFiles = imageFiles
    manifest.thumbnailFiles = thumbnailFiles
  }

  zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: exportedAtDate }]

  return {
    manifest,
    bytes: zipSync(zipFiles, { level: 6 }),
  }
}

export function getExportBlobLimitError(byteLength: number): string | null {
  if (byteLength > MAX_EXPORT_BLOB_BYTES) {
    return '当前备份文件超过浏览器支持的 2 GB 下载限制，请减少导出的图片或分批导出。'
  }
  return null
}

export function createExportBlob(bytes: Uint8Array): Blob {
  const limitError = getExportBlobLimitError(bytes.byteLength)
  if (limitError) throw new Error(limitError)

  if (bytes.byteLength <= EXPORT_BLOB_CHUNK_BYTES) {
    return new Blob([bytes], { type: 'application/zip' })
  }

  const parts: BlobPart[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += EXPORT_BLOB_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + EXPORT_BLOB_CHUNK_BYTES, bytes.byteLength))
    parts.push(chunk)
  }

  return new Blob(parts, { type: 'application/zip' })
}

export function buildExportZipParts(params: BuildExportZipParams, options: { maxBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? MAX_EXPORT_BLOB_BYTES
  if (!params.options.exportTasks || !params.tasks.length) {
    const result = buildExportZip(params)
    return [{ fileName: 'gpt-image-playground-backup.zip', manifest: result.manifest, bytes: result.bytes }]
  }

  const parts = splitExportZipTasks(params, maxBytes)
  return parts.map((part, index) => ({
    fileName: parts.length > 1 ? `gpt-image-playground-backup_part${String(index + 1).padStart(2, '0')}.zip` : 'gpt-image-playground-backup.zip',
    manifest: part.manifest,
    bytes: part.bytes,
  }))
}

function splitExportZipTasks(params: BuildExportZipParams, maxBytes: number, tasks = params.tasks): ExportZipPart[] {
  if (!tasks.length) return []
  const taskImageIds = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(taskImageIds, task)
  const images = params.images.filter((image) => taskImageIds.has(image.id))
  const thumbnailsByImageId = new Map<string, NonNullable<Awaited<ReturnType<typeof getImageThumbnail>>>>()
  for (const image of images) {
    const thumbnail = params.thumbnailsByImageId.get(image.id)
    if (thumbnail?.thumbnailDataUrl) thumbnailsByImageId.set(image.id, thumbnail)
  }
  const result = buildExportZip({
    ...params,
    tasks,
    images,
    thumbnailsByImageId,
  })
  if (result.bytes.byteLength <= maxBytes) {
    return [{ fileName: '', manifest: result.manifest, bytes: result.bytes }]
  }
  if (tasks.length === 1) {
    throw new Error('单个任务资源过大，无法继续拆分为更小的备份分包。请减少该任务中的图片后再试。')
  }
  const midpoint = Math.floor(tasks.length / 2)
  return [
    ...splitExportZipTasks(params, maxBytes, tasks.slice(0, midpoint)),
    ...splitExportZipTasks(params, maxBytes, tasks.slice(midpoint)),
  ]
}

function addTaskReferencedImageIds(taskImageIds: Set<string>, task: TaskRecord) {
  for (const imageId of [
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
    ...(task.transparentOriginalImages || []),
    ...(task.streamPartialImageIds || []),
  ]) {
    if (imageId) taskImageIds.add(imageId)
  }
}

export function readExportZip(bytes: Uint8Array): ExportZipContents {
  const files = unzipSync(bytes)
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

  return {
    manifest: JSON.parse(strFromU8(manifestBytes)) as ExportData,
    files,
  }
}

export function readExportZipFileAsDataUrl(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path]
  if (!bytes) return null
  return bytesToDataUrl(bytes, path)
}

function getImageCreatedAtFallback(tasks: TaskRecord[]) {
  const imageCreatedAtFallback = new Map<string, number>()

  for (const task of tasks) {
    for (const id of [
      ...(task.inputImageIds || []),
      ...(task.maskImageId ? [task.maskImageId] : []),
      ...(task.outputImages || []),
      ...(task.transparentOriginalImages || []),
      ...(task.streamPartialImageIds || []),
    ]) {
      if (!id) continue
      const prev = imageCreatedAtFallback.get(id)
      if (prev == null || task.createdAt < prev) imageCreatedAtFallback.set(id, task.createdAt)
    }
  }

  return imageCreatedAtFallback
}

function getImageFileNameBases(tasks: TaskRecord[]) {
  const bases = new Map<string, string>()

  for (const task of tasks) addImageFileNameBases(bases, task.outputImages || [], `task-${task.id}`)
  for (const task of tasks) addImageFileNameBases(bases, task.transparentOriginalImages || [], `task-${task.id}-orig`)
  for (const task of tasks) addImageFileNameBases(bases, task.streamPartialImageIds || [], `task-${task.id}-partial`)
  for (const task of tasks) addImageFileNameBases(bases, task.inputImageIds || [], `task-${task.id}-input`)
  for (const task of tasks) {
    if (task.maskImageId && !bases.has(task.maskImageId)) bases.set(task.maskImageId, `task-${task.id}-mask`)
  }

  return bases
}

function addImageFileNameBases(bases: Map<string, string>, imageIds: string[], fileNameBase: string) {
  const ids = imageIds.filter(Boolean)
  for (let index = 0; index < ids.length; index++) {
    if (bases.has(ids[index])) continue
    bases.set(ids[index], getNumberedFileNameBase(fileNameBase, index, ids.length))
  }
}

function getUniqueImagePath(fileNameBase: string, ext: string, usedPaths: Set<string>) {
  const base = sanitizeFileNamePart(fileNameBase) || 'image'
  let path = `images/${base}.${ext}`
  let duplicateIndex = 2
  while (usedPaths.has(path)) {
    path = `images/${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
    duplicateIndex++
  }
  usedPaths.add(path)
  return path
}
