import { describe, expect, it } from 'vitest'
import { DEFAULT_KALA_SYSTEM_PROMPT, createBuiltinTools } from './builtin-tools.js'

describe('built-in tool intent schema',()=>{
  it('keeps websearch execution on the Host',()=>{
    expect(createBuiltinTools().find((tool)=>tool.name==='websearch')).toMatchObject({
      executionKind: 'host',
      executionHandler: 'websearch',
    })
  })

  it('discloses semantic computer observations and bounded batches under the existing approval gate',()=>{
    const tool=createBuiltinTools().find((candidate)=>candidate.name==='computer_use')!
    expect(tool).toMatchObject({executionKind:'executor',executionHandler:'computer_use',requiresApproval:true})
    expect(tool.inputSchema.properties).toMatchObject({
      operation:{enum:['status','observe','act','batch','screenshot','input']},
      actions:{type:'array',minItems:1,maxItems:8},
    })
    expect(tool.description).toContain('latest observation')
    expect(tool.description).toContain('Never bypass another Session owning the desktop')
  })

  it('registers multi_grep as a bounded executor read tool',()=>{
    const tool=createBuiltinTools().find((candidate)=>candidate.name==='multi_grep')!
    expect(tool).toMatchObject({executionKind:'executor',executionHandler:'multi_grep',requiresApproval:false})
    const searches=(tool.inputSchema.properties as Record<string,any>).searches
    expect(searches).toMatchObject({type:'array',minItems:1,maxItems:20})
    expect(createBuiltinTools().some((candidate)=>candidate.name==='grep')).toBe(false)
    expect((tool.inputSchema.properties as Record<string,any>).max_bytes).toBeUndefined()
  })

  it('keeps interactive process writes and kills behind the shell approval gate',()=>{
    expect(createBuiltinTools().find((tool)=>tool.name==='process')).toMatchObject({
      executionKind:'executor',executionHandler:'process',requiresApproval:true,
    })
  })

  it('registers the task graph and scheduled task tools under planning',()=>{
    const planningTools=createBuiltinTools().filter((tool)=>tool.toolsetId==='planning')
    expect(planningTools.map((tool)=>tool.name)).toEqual(['todo_graph','scheduled_task'])
    expect(planningTools[0]).toMatchObject({executionKind:'host',executionHandler:'todo_graph'})
    expect(planningTools[1]).toMatchObject({executionKind:'host',executionHandler:'scheduled_task'})
  })

  it('keeps the Skill Tool schema independent from the discovered Skill registry',()=>{
    const empty=createBuiltinTools()
    const populated=createBuiltinTools([{
      name:'workspace-skill',
      description:'A workspace-specific Skill that must not enter the Tool schema.',
      path:'/placeholder/.agent/skills/workspace-skill/SKILL.md',
    }])
    const emptySkill=empty.find((tool)=>tool.name==='skill')!
    const populatedSkill=populated.find((tool)=>tool.name==='skill')!
    expect(populatedSkill).toEqual(emptySkill)
    expect(populatedSkill.description).not.toContain('workspace-skill')
    expect(populatedSkill.inputSchema.required).toContain('action')
  })

  it('exposes an explicit bounded subagent intention while retaining objective compatibility',()=>{
    const agent=createBuiltinTools().find((tool)=>tool.name==='agent')!
    const properties=agent.inputSchema.properties as Record<string,any>
    expect(properties.intention).toMatchObject({type:'string',minLength:12,maxLength:240})
    expect(properties.intention.description).toContain('single-line')
    expect(properties.intention.description).toContain('Do not copy the full prompt')
    expect(properties.prompt).toMatchObject({type:'string',minLength:1})
    expect(properties.prompt.description).toContain('sent verbatim')
    expect(properties.prompt.description).toContain('self-contained')
    expect(properties.prompt.description).toContain('readable Markdown')
    expect(properties.prompt.description).toContain('blank lines')
    expect(properties.prompt.description).toContain('bullet points')
    expect(properties.prompt.description).toContain('dense paragraph')
    expect(properties.expected_output.description).toContain('what the child must return')
    expect(properties.objective.description).toContain('Backward-compatible')
  })

  it('requires a natural-language intent on every tool call',()=>{
    for(const tool of createBuiltinTools()){
      const intent=(tool.inputSchema.properties as Record<string,any>)._intent
      expect(intent).toMatchObject({type:'string',minLength:12,maxLength:240})
      expect(intent.description).toContain('user’s current language')
      expect(intent.description).toContain('concrete user- or product-facing objective')
      expect(intent.description).toContain('Do not merely name the tool or operation')
      expect((tool.inputSchema.required as string[]|undefined)?.filter((key)=>key==='_intent')).toEqual(['_intent'])
    }
  })

  it('exposes web batches, provider pages and local search pagination', () => {
    const tools = createBuiltinTools()
    const web = tools.find((t) => t.name === 'websearch')!
    expect(web.inputSchema.properties).toMatchObject({
      limit: { maximum: 100, default: 5 }, page: { minimum: 1, maximum: 10 }, pages: { maximum: 5, default: 1 }, queries: { minItems: 1, maxItems: 5 },
    })
    expect(web.description).toContain('same query and limit')
    const item = (tools.find((t) => t.name === 'multi_grep')!.inputSchema.properties as Record<string, any>).searches.items
    expect(item.properties).toMatchObject({ limit: { maximum: 1000 }, offset: { minimum: 0 } })
    expect(tools.find((t) => t.name === 'glob')!.inputSchema.properties).toMatchObject({ path: { type: 'string' }, limit: { maximum: 1000 } })
  })

  it('scopes plans to the current goal with explicit handoffs and adaptive search', () => {
    const todo = createBuiltinTools().find((t) => t.name === 'todo_graph')!
    expect(todo.description).toContain('remove_node')
    expect(todo.description).toContain('unfinished work')
    expect(todo.description).toContain('clear when no current work remains')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('not a session-wide history')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('not automatically after one page')
  })

})
