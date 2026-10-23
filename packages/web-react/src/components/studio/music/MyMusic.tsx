// OCV5-593 FE-5 我的音乐 (d12): the user's own tracks, reusable across projects, and the upload
// dialog. An upload needs the uploader's statement that they own the music or are licensed to use
// it; the statement (and an optional note, e.g. a contract number) is stored with the track.

import { Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  UPLOAD_AUDIO_TYPES,
  UPLOAD_MAX_BYTES,
  studioApi,
  studioErrorText,
} from '../../../lib/studio/api'
import type { MusicTrack } from '../../../lib/studio/music'
import type { AuthSession } from '../../../lib/types'
import { useToast } from '../../ui'
import { StudioDialog } from '../Dialog'
import { TrackRow } from './TrackRow'
import type { Preview } from './usePreview'

function UploadDialog(props: { auth: AuthSession; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [rights, setRights] = useState(false)
  const [busy, setBusy] = useState(false)
  const tooBig = file !== null && file.size > UPLOAD_MAX_BYTES
  const wrongType = file !== null && !UPLOAD_AUDIO_TYPES.includes(file.type)
  const ok = file && !tooBig && !wrongType && title.trim() && rights
  return (
    <StudioDialog label="上传音乐" onClose={props.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ok || busy || !file) return
          setBusy(true)
          try {
            await studioApi.uploadTrack(props.auth, file, title, note)
            toast('已加到「我的音乐」，所有项目都能用', 'success')
            props.onDone()
          } catch (err) {
            toast(studioErrorText(err), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="st-row">
          <b className="st-h3">上传音乐</b>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-iconbtn" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <label className="st-field" htmlFor="st-mu-file">
          音乐文件（MP3 / WAV，最大 25 MB）
          <input
            id="st-mu-file"
            type="file"
            accept={UPLOAD_AUDIO_TYPES.join(',')}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              if (f && !title) setTitle(f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 200))
            }}
          />
        </label>
        {tooBig ? <output className="st-chip st-chip-bad">文件超过 25 MB</output> : null}
        {wrongType ? <output className="st-chip st-chip-bad">只支持 MP3 或 WAV</output> : null}
        <label className="st-field" htmlFor="st-mu-title">
          曲名
          <input
            id="st-mu-title"
            className="st-input"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="st-consent" htmlFor="st-mu-rights">
          <input
            id="st-mu-rights"
            type="checkbox"
            checked={rights}
            onChange={(e) => setRights(e.target.checked)}
          />
          <span>我拥有这段音乐，或已获得在商业视频中使用它的授权。这条声明会和音乐一起保存。</span>
        </label>
        <label className="st-field" htmlFor="st-mu-note">
          授权说明（可选）
          <input
            id="st-mu-note"
            className="st-input"
            maxLength={300}
            value={note}
            placeholder="例如：客户 2026-10 授权，合同编号…"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="submit" className="st-btn st-btn-primary" disabled={!ok || busy}>
          <Upload />
          {busy ? '上传中…' : '上传'}
        </button>
      </form>
    </StudioDialog>
  )
}

export function MyMusic(props: {
  auth: AuthSession
  providerId: string
  inUseSha: string | null
  busy: boolean
  preview: Preview
  onUse: (track: MusicTrack) => void
  onFocus: (track: MusicTrack) => void
  onError: (err: unknown) => void
}) {
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null)
  const [uploading, setUploading] = useState(false)
  const onError = useRef(props.onError)
  onError.current = props.onError
  const load = useCallback(async () => {
    try {
      setTracks((await studioApi.musicSearch(props.auth, props.providerId, {})).tracks)
    } catch (err) {
      setTracks((cur) => cur ?? [])
      onError.current(err)
    }
  }, [props.auth, props.providerId])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="st-lib">
      <div className="st-row st-lib-count">
        <span className="st-cap">
          你上传过的音乐在所有项目里都能用。只上传你拥有或已获授权的音乐。
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="st-btn st-btn-primary st-btn-sm"
          onClick={() => setUploading(true)}
        >
          <Upload />
          上传音乐
        </button>
      </div>
      <div className="st-col st-lib-list" aria-busy={tracks === null}>
        {tracks?.length === 0 ? (
          <div className="st-card st-lib-empty st-cap">
            还没有上传过音乐。上传后可以在任何项目里用作配乐。
          </div>
        ) : null}
        {(tracks ?? []).map((t) => (
          <TrackRow
            key={t.id}
            track={t}
            playing={props.preview.playing === t.previewSha}
            loading={props.preview.loading === t.previewSha}
            inUse={props.inUseSha === t.previewSha}
            busy={props.busy}
            onPlay={() => props.preview.toggle(t.previewSha)}
            onUse={() => props.onUse(t)}
            onFocus={() => props.onFocus(t)}
          />
        ))}
      </div>
      {uploading ? (
        <UploadDialog
          auth={props.auth}
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}
