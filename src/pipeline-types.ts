export interface PipelineStep {
  id: string
  find: string
  replace: string
  useRegex: boolean
  flags: {
    g: boolean
    i: boolean
    m: boolean
    s: boolean
  }
}

export interface RegexPreset {
  id: string
  name: string
  description?: string
  steps: PipelineStep[]
}
