import assert from 'node:assert/strict';
import { validateDiagramSyntax } from '../validator.mjs';

// Provided diagram (should fail with parser since flowchart is unsupported here)
const providedDiagram = `graph TD;
    A[Start AI Development] --> B{Limiting Factors};
    B --> C[Compute];
    B --> D[Data];
    B --> E[Algorithmic Design];
    B --> F[Product Development];

    C -- "Challenges" --> C1[Energy Availability];
    C -- "Challenges" --> C2[Chip & Memory Supply];
    C -- "Challenges" --> C3[Infrastructure Construction];
    C1 & C2 & C3 --> C4[Goal: Automate Data Center Building];

    D -- "Challenges" --> D1[Models Understand Existing Data Well];
    D -- "Challenges" --> D2[Need to Discover New Things];
    D1 & D2 --> D3[Solution: Teach Models to Hypothesize & Experiment];

    E -- "Progress" --> E1[GPT Paradigm];
    E -- "Progress" --> E2[Reasoning Paradigm];
    E -- "Progress" --> E3[New Gains (e.g., GPOSS)];

    F -- "Importance" --> F1[Scientific Progress Needs Application];
    F1 --> F2[Co-evolution with Society];`;

// Valid diagram using a supported type (graph)
const validDiagram = `graph TD
    A[Start] --> B{Decision?}
    B -->|Yes| C[Process]
    B -->|No| D[End]
    C --> D`;

async function run() {
  // Test 1: The provided diagram should fail (has syntax error with parentheses)
  const provided = await validateDiagramSyntax(providedDiagram);
  assert.equal(provided.valid, false, 'Expected provided diagram to be invalid due to parentheses in labels');
  assert.ok(typeof provided.error === 'string' && provided.error.length > 0, 'Expected an error message');
  console.log('✓ Test 1 passed: Invalid diagram correctly rejected');

  // Test 2: A valid graph diagram should pass
  const valid = await validateDiagramSyntax(validDiagram);
  assert.equal(valid.valid, true, 'Expected valid diagram to be valid');
  console.log('✓ Test 2 passed: Valid diagram correctly accepted');
  
  console.log('\nAll tests passed!');
}

run();


