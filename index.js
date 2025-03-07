#!/usr/bin/env node

/**
 * Chain of Draft (CoD) MCP Server in pure JavaScript
 * Implements the MCP server for Chain of Draft reasoning
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Anthropic } from "@anthropic-ai/sdk";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Initialize the Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "your_api_key_here",
});

// Initialize database connection for analytics
// This is a simplified in-memory version
const analyticsDb = {
  records: [],
  addRecord: function(record) {
    this.records.push({
      ...record,
      timestamp: new Date()
    });
    return this.records.length;
  },
  getPerformanceByDomain: function(domain) {
    let filtered = domain 
      ? this.records.filter(r => r.domain === domain) 
      : this.records;
    
    // Group by domain and approach
    const grouped = {};
    for (const record of filtered) {
      const key = `${record.domain}-${record.approach}`;
      if (!grouped[key]) {
        grouped[key] = {
          domain: record.domain,
          approach: record.approach,
          total_tokens: 0,
          total_time: 0,
          count: 0,
          accuracy: null
        };
      }
      grouped[key].total_tokens += record.tokens_used;
      grouped[key].total_time += record.execution_time_ms;
      grouped[key].count += 1;
    }
    
    // Calculate averages
    return Object.values(grouped).map(g => ({
      domain: g.domain,
      approach: g.approach,
      avg_tokens: g.total_tokens / g.count,
      avg_time_ms: g.total_time / g.count,
      accuracy: g.accuracy,
      count: g.count
    }));
  },
  getTokenReductionStats: function() {
    // Group by domain
    const domains = {};
    for (const record of this.records) {
      if (!domains[record.domain]) {
        domains[record.domain] = {
          cod_tokens: [],
          cot_tokens: []
        };
      }
      
      if (record.approach === 'CoD') {
        domains[record.domain].cod_tokens.push(record.tokens_used);
      } else if (record.approach === 'CoT') {
        domains[record.domain].cot_tokens.push(record.tokens_used);
      }
    }
    
    // Calculate reduction stats
    return Object.entries(domains).map(([domain, data]) => {
      const cod_avg = data.cod_tokens.length 
        ? data.cod_tokens.reduce((a, b) => a + b, 0) / data.cod_tokens.length 
        : 0;
      const cot_avg = data.cot_tokens.length 
        ? data.cot_tokens.reduce((a, b) => a + b, 0) / data.cot_tokens.length 
        : 0;
      
      let reduction = 0;
      if (cot_avg > 0 && cod_avg > 0) {
        reduction = 100 * (1 - (cod_avg / cot_avg));
      }
      
      return {
        domain,
        cod_avg_tokens: cod_avg,
        cot_avg_tokens: cot_avg,
        reduction_percentage: reduction
      };
    });
  }
};

// Complexity estimation logic
const complexityEstimator = {
  domainBaseLimits: {
    math: 6,
    logic: 5,
    common_sense: 4,
    physics: 7,
    chemistry: 6,
    biology: 5,
    code: 8,
    puzzle: 5,
    general: 5
  },
  complexityIndicators: {
    math: ['integral', 'derivative', 'equation', 'theorem', 'calculus', 'polynomial', 'algorithm'],
    logic: ['if-then', 'premise', 'fallacy', 'syllogism', 'deduction', 'induction'],
    physics: ['velocity', 'acceleration', 'quantum', 'momentum', 'thermodynamics'],
    code: ['function', 'algorithm', 'recursive', 'complexity', 'optimization', 'edge case']
  },
  analyzeProblem: function(problem, domain) {
    const wordCount = problem.split(/\s+/).filter(Boolean).length;
    const sentences = problem.split(/[.!?]+/).filter(Boolean);
    const sentenceCount = sentences.length;
    const wordsPerSentence = sentenceCount > 0 ? wordCount / sentenceCount : 0;
    
    // Count indicators
    const indicators = this.complexityIndicators[domain] || this.complexityIndicators.general || [];
    const lowerProblem = problem.toLowerCase();
    const foundIndicators = indicators.filter(i => lowerProblem.includes(i.toLowerCase()));
    
    // Count questions
    const questionCount = (problem.match(/\?/g) || []).length;
    
    // Estimate complexity
    let complexity = this.domainBaseLimits[domain] || this.domainBaseLimits.general;
    
    // Adjust for length
    if (wordCount > 100) complexity += 2;
    else if (wordCount > 50) complexity += 1;
    
    // Adjust for sentences
    if (wordsPerSentence > 20) complexity += 1;
    
    // Adjust for indicators
    complexity += Math.min(3, foundIndicators.length);
    
    // Adjust for questions
    complexity += Math.min(2, questionCount);
    
    return {
      word_count: wordCount,
      sentence_count: sentenceCount,
      words_per_sentence: wordsPerSentence,
      indicator_count: foundIndicators.length,
      found_indicators: foundIndicators,
      question_count: questionCount,
      estimated_complexity: complexity
    };
  }
};

// Format enforcement
const formatEnforcer = {
  enforceWordLimit: function(reasoning, maxWordsPerStep) {
    if (!maxWordsPerStep) return reasoning;
    
    // Split into steps
    const stepPattern = /(\d+\.\s*|Step\s+\d+:|\n-\s+|\n\*\s+|•\s+|^\s*-\s+|^\s*\*\s+)/;
    let steps = reasoning.split(stepPattern).filter(Boolean);
    
    // Process steps
    const processed = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Check if this is a step marker
      if (step.match(stepPattern)) {
        processed.push(step);
        continue;
      }
      
      // Enforce word limit on this step
      const words = step.split(/\s+/).filter(Boolean);
      if (words.length <= maxWordsPerStep) {
        processed.push(step);
      } else {
        // Truncate to word limit
        processed.push(words.slice(0, maxWordsPerStep).join(' '));
      }
    }
    
    return processed.join('');
  },
  
  analyzeAdherence: function(reasoning, maxWordsPerStep) {
    // Split into steps
    const stepPattern = /(\d+\.\s*|Step\s+\d+:|\n-\s+|\n\*\s+|•\s+|^\s*-\s+|^\s*\*\s+)/;
    let steps = reasoning.split(stepPattern).filter(Boolean);
    
    let totalWords = 0;
    let stepCount = 0;
    let overLimitSteps = 0;
    
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Skip step markers
      if (step.match(stepPattern)) continue;
      
      stepCount++;
      const wordCount = step.split(/\s+/).filter(Boolean).length;
      totalWords += wordCount;
      
      if (wordCount > maxWordsPerStep) {
        overLimitSteps++;
      }
    }
    
    return {
      step_count: stepCount,
      total_words: totalWords,
      avg_words_per_step: stepCount > 0 ? totalWords / stepCount : 0,
      over_limit_steps: overLimitSteps,
      adherence_percentage: stepCount > 0 ? (1 - (overLimitSteps / stepCount)) * 100 : 100
    };
  }
};

// Reasoning approach selector
const reasoningSelector = {
  defaultPreferences: {
    math: {
      complexity_threshold: 7,
      accuracy_threshold: 0.85
    },
    code: {
      complexity_threshold: 8,
      accuracy_threshold: 0.9
    },
    general: {
      complexity_threshold: 6,
      accuracy_threshold: 0.8
    }
  },
  
  selectApproach: function(domain, complexity, performanceStats) {
    // Default preferences for domain
    const prefs = this.defaultPreferences[domain] || this.defaultPreferences.general;
    
    // By default, use CoD for simpler problems
    if (complexity < prefs.complexity_threshold) {
      return 'CoD';
    }
    
    // For complex problems, check past performance if available
    if (performanceStats && performanceStats.length > 0) {
      const domainStats = performanceStats.filter(s => s.domain === domain);
      
      // Check if CoD has good enough accuracy
      const codStats = domainStats.find(s => s.approach === 'CoD');
      if (codStats && codStats.accuracy && codStats.accuracy >= prefs.accuracy_threshold) {
        return 'CoD';
      }
      
      // Otherwise, use CoT for complex problems
      return 'CoT';
    }
    
    // Use CoT for complex problems by default
    return complexity >= prefs.complexity_threshold ? 'CoT' : 'CoD';
  }
};

// Prompt creation
function createCodPrompt(problem, domain, examples = [], wordLimit = 5) {
  return `
You will solve this ${domain} problem using the Chain of Draft technique, which uses very concise reasoning steps.

For each step, use at most ${wordLimit} words. Be extremely concise but clear.

PROBLEM:
${problem}

To solve this, create short reasoning steps, with each step using at most ${wordLimit} words.
After your reasoning, state your final answer clearly.
`.trim();
}

function createCotPrompt(problem, domain, examples = []) {
  return `
You will solve this ${domain} problem using detailed step-by-step reasoning.

PROBLEM:
${problem}

Think through this problem step-by-step with clear reasoning.
After your reasoning, state your final answer clearly.
`.trim();
}

// Chain of Draft client implementation
const chainOfDraftClient = {
  async solveWithReasoning(params) {
    const {
      problem,
      domain = 'general',
      max_words_per_step = null,
      approach = null,
      enforce_format = true,
      adaptive_word_limit = true
    } = params;
    
    const startTime = Date.now();
    
    // Analyze problem complexity
    const analysis = complexityEstimator.analyzeProblem(problem, domain);
    const complexity = analysis.estimated_complexity;
    
    // Determine word limit
    let wordLimit = max_words_per_step;
    if (!wordLimit && adaptive_word_limit) {
      wordLimit = complexity;
    } else if (!wordLimit) {
      // Default based on domain
      wordLimit = complexityEstimator.domainBaseLimits[domain] || 5;
    }
    
    // Determine approach (CoD or CoT)
    const performanceStats = analyticsDb.getPerformanceByDomain(domain);
    const selectedApproach = approach || 
      reasoningSelector.selectApproach(domain, complexity, performanceStats);
    
    // Create prompt based on approach
    const prompt = selectedApproach === 'CoD' 
      ? createCodPrompt(problem, domain, [], wordLimit)
      : createCotPrompt(problem, domain, []);
    
    // Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: prompt }
      ]
    });
    
    // Extract reasoning and answer
    const fullText = response.content[0].text;
    
    // Extract final answer (assuming it comes after the reasoning, often starts with "Answer:" or similar)
    let reasoningSteps = fullText;
    let finalAnswer = '';
    
    // Common patterns for final answer sections
    const answerPatterns = [
      /(?:Final Answer|Answer|Therefore):?\s*(.*?)$/is,
      /(?:In conclusion|To conclude|Thus|Hence|So),\s*(.*?)$/is,
      /(?:The answer is|The result is|The solution is)\s*(.*?)$/is
    ];
    
    // Try to extract the final answer with each pattern
    for (const pattern of answerPatterns) {
      const match = fullText.match(pattern);
      if (match && match[1]) {
        finalAnswer = match[1].trim();
        reasoningSteps = fullText.substring(0, fullText.indexOf(match[0])).trim();
        break;
      }
    }
    
    // If no pattern matched, just use the last sentence
    if (!finalAnswer) {
      const sentences = fullText.split(/[.!?]+\s+/);
      if (sentences.length > 1) {
        finalAnswer = sentences.pop().trim();
        reasoningSteps = sentences.join('. ') + '.';
      }
    }
    
    // Apply format enforcement if needed
    if (enforce_format && selectedApproach === 'CoD') {
      reasoningSteps = formatEnforcer.enforceWordLimit(reasoningSteps, wordLimit);
    }
    
    // Calculate execution time
    const executionTime = Date.now() - startTime;
    
    // Estimate token count (rough approximation)
    const tokenCount = Math.ceil(fullText.length / 4);
    
    // Record analytics
    analyticsDb.addRecord({
      problem_id: problem.substring(0, 20),
      problem_text: problem,
      domain,
      approach: selectedApproach,
      word_limit: wordLimit,
      tokens_used: tokenCount,
      execution_time_ms: executionTime,
      reasoning_steps: reasoningSteps,
      answer: finalAnswer
    });
    
    // Return result
    return {
      approach: selectedApproach,
      reasoning_steps: reasoningSteps,
      final_answer: finalAnswer,
      token_count: tokenCount,
      word_limit: wordLimit,
      complexity: complexity,
      execution_time_ms: executionTime
    };
  }
};

// Define the Chain of Draft tool
const CHAIN_OF_DRAFT_TOOL = {
  name: "chain_of_draft_solve",
  description: "Solve a reasoning problem using Chain of Draft approach",
  inputSchema: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description: "The problem to solve"
      },
      domain: {
        type: "string",
        description: "Domain for context (math, logic, code, common-sense, etc.)"
      },
      max_words_per_step: {
        type: "number",
        description: "Maximum words per reasoning step"
      },
      approach: {
        type: "string",
        description: "Force 'CoD' or 'CoT' approach"
      },
      enforce_format: {
        type: "boolean",
        description: "Whether to enforce the word limit"
      },
      adaptive_word_limit: {
        type: "boolean",
        description: "Adjust word limits based on complexity"
      }
    },
    required: ["problem"]
  }
};

const MATH_TOOL = {
  name: "math_solve",
  description: "Solve a math problem using Chain of Draft reasoning",
  inputSchema: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description: "The math problem to solve"
      },
      approach: {
        type: "string",
        description: "Force 'CoD' or 'CoT' approach"
      },
      max_words_per_step: {
        type: "number",
        description: "Maximum words per reasoning step"
      }
    },
    required: ["problem"]
  }
};

const CODE_TOOL = {
  name: "code_solve",
  description: "Solve a coding problem using Chain of Draft reasoning",
  inputSchema: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description: "The coding problem to solve"
      },
      approach: {
        type: "string",
        description: "Force 'CoD' or 'CoT' approach"
      },
      max_words_per_step: {
        type: "number",
        description: "Maximum words per reasoning step"
      }
    },
    required: ["problem"]
  }
};

const LOGIC_TOOL = {
  name: "logic_solve",
  description: "Solve a logic problem using Chain of Draft reasoning",
  inputSchema: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description: "The logic problem to solve"
      },
      approach: {
        type: "string",
        description: "Force 'CoD' or 'CoT' approach"
      },
      max_words_per_step: {
        type: "number",
        description: "Maximum words per reasoning step"
      }
    },
    required: ["problem"]
  }
};

const PERFORMANCE_TOOL = {
  name: "get_performance_stats",
  description: "Get performance statistics for CoD vs CoT approaches",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Filter for specific domain"
      }
    }
  }
};

const TOKEN_TOOL = {
  name: "get_token_reduction",
  description: "Get token reduction statistics for CoD vs CoT",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const COMPLEXITY_TOOL = {
  name: "analyze_problem_complexity",
  description: "Analyze the complexity of a problem",
  inputSchema: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description: "The problem to analyze"
      },
      domain: {
        type: "string",
        description: "Problem domain"
      }
    },
    required: ["problem"]
  }
};

// Initialize the MCP server
const server = new Server({
  name: "chain-of-draft",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {},
  },
});

// Expose available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    CHAIN_OF_DRAFT_TOOL,
    MATH_TOOL,
    CODE_TOOL,
    LOGIC_TOOL,
    PERFORMANCE_TOOL,
    TOKEN_TOOL,
    COMPLEXITY_TOOL
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    // Chain of Draft solve
    if (name === "chain_of_draft_solve") {
      const result = await chainOfDraftClient.solveWithReasoning(args);
      
      const formattedResponse = 
        `Chain of ${result.approach} reasoning (${result.word_limit} word limit):\n\n` +
        `${result.reasoning_steps}\n\n` +
        `Final answer: ${result.final_answer}\n\n` +
        `Stats: ${result.token_count} tokens, ${result.execution_time_ms.toFixed(0)}ms, ` +
        `complexity score: ${result.complexity}`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse
        }]
      };
    }
    
    // Math solver
    if (name === "math_solve") {
      const result = await chainOfDraftClient.solveWithReasoning({
        ...args,
        domain: "math"
      });
      
      const formattedResponse = 
        `Chain of ${result.approach} reasoning (${result.word_limit} word limit):\n\n` +
        `${result.reasoning_steps}\n\n` +
        `Final answer: ${result.final_answer}\n\n` +
        `Stats: ${result.token_count} tokens, ${result.execution_time_ms.toFixed(0)}ms, ` +
        `complexity score: ${result.complexity}`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse
        }]
      };
    }
    
    // Code solver
    if (name === "code_solve") {
      const result = await chainOfDraftClient.solveWithReasoning({
        ...args,
        domain: "code"
      });
      
      const formattedResponse = 
        `Chain of ${result.approach} reasoning (${result.word_limit} word limit):\n\n` +
        `${result.reasoning_steps}\n\n` +
        `Final answer: ${result.final_answer}\n\n` +
        `Stats: ${result.token_count} tokens, ${result.execution_time_ms.toFixed(0)}ms, ` +
        `complexity score: ${result.complexity}`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse
        }]
      };
    }
    
    // Logic solver
    if (name === "logic_solve") {
      const result = await chainOfDraftClient.solveWithReasoning({
        ...args,
        domain: "logic"
      });
      
      const formattedResponse = 
        `Chain of ${result.approach} reasoning (${result.word_limit} word limit):\n\n` +
        `${result.reasoning_steps}\n\n` +
        `Final answer: ${result.final_answer}\n\n` +
        `Stats: ${result.token_count} tokens, ${result.execution_time_ms.toFixed(0)}ms, ` +
        `complexity score: ${result.complexity}`;
      
      return {
        content: [{
          type: "text",
          text: formattedResponse
        }]
      };
    }
    
    // Performance stats
    if (name === "get_performance_stats") {
      const stats = analyticsDb.getPerformanceByDomain(args.domain);
      
      let result = "Performance Comparison (CoD vs CoT):\n\n";
      
      if (!stats || stats.length === 0) {
        result = "No performance data available yet.";
      } else {
        for (const stat of stats) {
          result += `Domain: ${stat.domain}\n`;
          result += `Approach: ${stat.approach}\n`;
          result += `Average tokens: ${stat.avg_tokens.toFixed(1)}\n`;
          result += `Average time: ${stat.avg_time_ms.toFixed(1)}ms\n`;
          
          if (stat.accuracy !== null) {
            result += `Accuracy: ${(stat.accuracy * 100).toFixed(1)}%\n`;
          }
          
          result += `Sample size: ${stat.count}\n\n`;
        }
      }
      
      return {
        content: [{
          type: "text",
          text: result
        }]
      };
    }
    
    // Token reduction
    if (name === "get_token_reduction") {
      const stats = analyticsDb.getTokenReductionStats();
      
      let result = "Token Reduction Analysis:\n\n";
      
      if (!stats || stats.length === 0) {
        result = "No reduction data available yet.";
      } else {
        for (const stat of stats) {
          result += `Domain: ${stat.domain}\n`;
          result += `CoD avg tokens: ${stat.cod_avg_tokens.toFixed(1)}\n`;
          result += `CoT avg tokens: ${stat.cot_avg_tokens.toFixed(1)}\n`;
          result += `Reduction: ${stat.reduction_percentage.toFixed(1)}%\n\n`;
        }
      }
      
      return {
        content: [{
          type: "text",
          text: result
        }]
      };
    }
    
    // Complexity analysis
    if (name === "analyze_problem_complexity") {
      const analysis = complexityEstimator.analyzeProblem(args.problem, args.domain || "general");
      
      let result = `Complexity Analysis for ${args.domain || "general"} problem:\n\n`;
      result += `Word count: ${analysis.word_count}\n`;
      result += `Sentence count: ${analysis.sentence_count}\n`;
      result += `Words per sentence: ${analysis.words_per_sentence.toFixed(1)}\n`;
      result += `Complexity indicators found: ${analysis.indicator_count}\n`;
      
      if (analysis.found_indicators && analysis.found_indicators.length > 0) {
        result += `Indicators: ${analysis.found_indicators.join(", ")}\n`;
      }
      
      result += `Question count: ${analysis.question_count}\n`;
      result += `\nEstimated complexity score: ${analysis.estimated_complexity}\n`;
      result += `Recommended word limit per step: ${analysis.estimated_complexity}\n`;
      
      return {
        content: [{
          type: "text",
          text: result
        }]
      };
    }
    
    // Handle unknown tool
    return {
      content: [{
        type: "text",
        text: `Unknown tool: ${name}`
      }],
      isError: true
    };
  } catch (error) {
    console.error("Error executing tool:", error);
    return {
      content: [{
        type: "text",
        text: `Error executing tool ${name}: ${error.message}`
      }],
      isError: true
    };
  }
});

// Start the server
async function runServer() {
  const transport = new StdioServerTransport();
  
  console.error("Chain of Draft MCP Server starting...");
  
  try {
    // Connect to the transport
    await server.connect(transport);
    console.error("Server connected to transport");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Run the server
runServer().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});