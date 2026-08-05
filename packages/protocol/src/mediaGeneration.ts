import { type Static, Type } from '@sinclair/typebox'

export const MEDIA_JOB_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'reconnecting',
  'completed',
  'failed',
  'canceled',
] as const
export type MediaJobStatus = (typeof MEDIA_JOB_STATUSES)[number]

export const MEDIA_JOB_TERMINAL_STATUSES: readonly MediaJobStatus[] = [
  'completed',
  'failed',
  'canceled',
]

export const MediaGenerationJobSchema = Type.Object({
  id: Type.String(),
  requestId: Type.String(),
  kind: Type.Union([Type.Literal('h3_generate'), Type.Literal('video_compose')]),
  resourceClass: Type.Union([Type.Literal('gpu-h3'), Type.Literal('cpu-compose')]),
  status: Type.Union(MEDIA_JOB_STATUSES.map((value) => Type.Literal(value))),
  phase: Type.String(),
  prompt: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  projectShotId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  durationSeconds: Type.Optional(Type.Number()),
  aspect: Type.Optional(Type.String()),
  currentStep: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  totalSteps: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  queuePosition: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  resultUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resultSha256: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resultSize: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  errorCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})
export type MediaGenerationJob = Static<typeof MediaGenerationJobSchema>

export const VideoProjectShotSchema = Type.Object({
  id: Type.String(),
  ordinal: Type.Number(),
  prompt: Type.String(),
  durationSeconds: Type.Number(),
  activeJobId: Type.Union([Type.String(), Type.Null()]),
  activeJob: Type.Optional(Type.Union([MediaGenerationJobSchema, Type.Null()])),
  stale: Type.Boolean(),
})
export type VideoProjectShot = Static<typeof VideoProjectShotSchema>

export const VideoProjectSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  rev: Type.Number(),
  status: Type.Union([
    Type.Literal('draft'),
    Type.Literal('generating'),
    Type.Literal('needs_review'),
    Type.Literal('ready'),
    Type.Literal('rendering'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('canceled'),
  ]),
  currentComposeJobId: Type.Union([Type.String(), Type.Null()]),
  shots: Type.Array(VideoProjectShotSchema),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})
export type VideoProject = Static<typeof VideoProjectSchema>

export const SysMediaJob = Type.Object({
  type: Type.Literal('sys.media_job'),
  job: MediaGenerationJobSchema,
  ts: Type.Number(),
})
export type SysMediaJob = Static<typeof SysMediaJob>
