import type { LlmAdapter, LlmRequest } from "../index.js";

const CIT = { type: "object", additionalProperties: false, required: ["videoId","startSeconds","endSeconds","chunkId"], properties: { videoId:{type:"string"}, startSeconds:{type:"number"}, endSeconds:{type:"number"}, chunkId:{type:"string"} } };
const QA_CIT = { type: "object", additionalProperties: false, required: ["videoId","startSeconds","endSeconds","chunkId","text"], properties: { videoId:{type:"string"}, startSeconds:{type:"number"}, endSeconds:{type:"number"}, chunkId:{type:"string"}, text:{type:"string"} } };
const RNG = { type: "object", additionalProperties: false, required: ["videoId","startSeconds","endSeconds"], properties: { videoId:{type:"string"}, startSeconds:{type:"number"}, endSeconds:{type:"number"} } };

const SCHEMAS: Record<string, any> = {
  "chunk-notes": { type:"object", additionalProperties:false, required:["chunkId","videoId","summary","keyPoints","concepts","citations"], properties:{ chunkId:{type:"string"}, videoId:{type:"string"}, summary:{type:"string"}, keyPoints:{type:"array",items:{type:"string"}}, concepts:{type:"array",items:{type:"string"}}, citations:{type:"array",items:CIT} } },
  "video-summary": { type:"object", additionalProperties:false, required:["videoId","summary","keyPoints","citations"], properties:{ videoId:{type:"string"}, summary:{type:"string"}, keyPoints:{type:"array",items:{type:"string"}}, citations:{type:"array",items:CIT} } },
  "playlist-syllabus": { type:"object", additionalProperties:false, required:["courseId","title","modules"], properties:{ courseId:{type:"string"}, title:{type:"string"}, modules:{type:"array",items:{ type:"object",additionalProperties:false,required:["title","summary","videoIds","outcomes"], properties:{ title:{type:"string"}, summary:{type:"string"}, videoIds:{type:"array",items:{type:"string"}}, outcomes:{type:"array",items:{type:"string"}} } }} } },
  "glossary": { type:"object", additionalProperties:false, required:["terms"], properties:{ terms:{type:"array",items:{ type:"object",additionalProperties:false,required:["term","definition","citations"], properties:{ term:{type:"string"}, definition:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "quiz": { type:"object", additionalProperties:false, required:["questions"], properties:{ questions:{type:"array",items:{ type:"object",additionalProperties:false,required:["question","choices","answer","explanation","citations"], properties:{ question:{type:"string"}, choices:{type:"array",items:{type:"string"},minItems:2}, answer:{type:"string"}, explanation:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "flashcards": { type:"object", additionalProperties:false, required:["cards"], properties:{ cards:{type:"array",items:{ type:"object",additionalProperties:false,required:["front","back","citations"], properties:{ front:{type:"string"}, back:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "study-plan": { type:"object", additionalProperties:false, required:["courseId","steps"], properties:{ courseId:{type:"string"}, steps:{type:"array",items:{ type:"object",additionalProperties:false,required:["title","objective","videoIds"], properties:{ title:{type:"string"}, objective:{type:"string"}, videoIds:{type:"array",items:{type:"string"}} } }} } },
  "prerequisite-map": { type:"object", additionalProperties:false, required:["prerequisites"], properties:{ prerequisites:{type:"array",items:{ type:"object",additionalProperties:false,required:["concept","requiredBefore","reason","citations"], properties:{ concept:{type:"string"}, requiredBefore:{type:"array",items:{type:"string"}}, reason:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "retrieval-qa-answer": { type:"object", additionalProperties:false, required:["answer","status","citations","replayRanges","followUpQuestions","confidence"], properties:{ answer:{type:"string"}, status:{type:"string",enum:["answered","insufficient_context"]}, citations:{type:"array",items:QA_CIT}, replayRanges:{type:"array",items:RNG}, followUpQuestions:{type:"array",items:{type:"string"}}, confidence:{ type:"object",additionalProperties:false,required:["score","reason"], properties:{ score:{type:"number"}, reason:{type:"string"} } } } },
};

export function createOpenAiLlmAdapter(apiKey: string, model = "gpt-4o-mini"): LlmAdapter {
  return {
    async generateStructured<T>(request: LlmRequest): Promise<T> {
      const schema = SCHEMAS[request.task];
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Return only valid JSON matching the schema. Preserve citation and chunk IDs exactly." },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          response_format: schema
            ? { type: "json_schema", json_schema: { name: request.task.replace(/-/g, "_"), strict: true, schema } }
            : { type: "json_object" },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => "")}`);
      return JSON.parse((await res.json() as any).choices[0].message.content) as T;
    },
  };
}
