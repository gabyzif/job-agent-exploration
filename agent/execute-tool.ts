import { tools, type ToolName } from './tools/index.ts'

export const executeTool = async (
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const tool = tools[name as ToolName]
  if (!tool) {
    return { error: `Unknown tool: ${name}` }
  }

  return (tool.execute as (args: Record<string, unknown>) => Promise<unknown>)(args)
}
