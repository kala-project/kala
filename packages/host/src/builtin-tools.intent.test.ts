import { describe, expect, it } from 'vitest'
import { createBuiltinTools } from './builtin-tools.js'

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
    expect(tool.description).toContain('Never enable it')
  })

  it('registers multi_grep as a bounded executor read tool',()=>{
    const tool=createBuiltinTools().find((candidate)=>candidate.name==='multi_grep')!
    expect(tool).toMatchObject({executionKind:'executor',executionHandler:'multi_grep',requiresApproval:false})
    const searches=(tool.inputSchema.properties as Record<string,any>).searches
    expect(searches).toMatchObject({type:'array',minItems:1,maxItems:20})
    expect(createBuiltinTools().some((candidate)=>candidate.name==='grep')).toBe(false)
    expect((tool.inputSchema.properties as Record<string,any>).max_bytes).toBeUndefined()
  })

  it('registers todo_graph as the only planning tool',()=>{
    const planningTools=createBuiltinTools().filter((tool)=>tool.toolsetId==='planning')
    expect(planningTools.map((tool)=>tool.name)).toEqual(['todo_graph'])
    expect(planningTools[0]).toMatchObject({executionKind:'host',executionHandler:'todo_graph'})
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
})
