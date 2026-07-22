import { resolveJobDescriptionTool } from './resolve-job-description.ts'

export const tools = {
  resolveJobDescription: resolveJobDescriptionTool,
}

export type ToolName = keyof typeof tools
