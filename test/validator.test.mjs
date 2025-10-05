import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDiagramSyntax } from '../validator.mjs';
import { validateLatex } from '../latex-validator.mjs';

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
  console.log('Running Mermaid validation tests...');
  
  // Test 1: The provided diagram should fail (has syntax error with parentheses)
  const provided = await validateDiagramSyntax(providedDiagram);
  assert.equal(provided.valid, false, 'Expected provided diagram to be invalid due to parentheses in labels');
  assert.ok(typeof provided.error === 'string' && provided.error.length > 0, 'Expected an error message');
  console.log('✓ Test 1 passed: Invalid diagram correctly rejected');

  // Test 2: A valid graph diagram should pass
  const valid = await validateDiagramSyntax(validDiagram);
  assert.equal(valid.valid, true, 'Expected valid diagram to be valid');
  console.log('✓ Test 2 passed: Valid diagram correctly accepted');
  
  console.log('\nRunning LaTeX validation tests...');
  
  // Test 3: Valid LaTeX should pass
  const validLatex = validateLatex('This is valid LaTeX: \\(x = \\frac{a}{b}\\)');
  assert.equal(validLatex.isValid, true, 'Expected valid LaTeX to be valid');
  console.log('✓ Test 3 passed: Valid LaTeX correctly accepted');
  
  // Test 4: Invalid LaTeX should fail
  const invalidLatex = validateLatex('This has invalid LaTeX: \\(x = \\frac{a{b}\\)');
  assert.equal(invalidLatex.isValid, false, 'Expected invalid LaTeX to be invalid');
  assert.ok(invalidLatex.errors.length > 0, 'Expected errors for invalid LaTeX');
  console.log('✓ Test 4 passed: Invalid LaTeX correctly rejected');
  
  // Test 5: LaTeX with display math should work
  const displayMath = validateLatex('Display math: \\[E = mc^2\\]');
  assert.equal(displayMath.isValid, true, 'Expected display math to be valid');
  console.log('✓ Test 5 passed: Display math correctly accepted');
  
  // Test 6: Single dollar signs should be allowed (for currency)
  const singleDollar = validateLatex('The price is $5 and tax is $2');
  assert.equal(singleDollar.isValid, true, 'Expected single dollars to be valid (treated as plain text)');
  console.log('✓ Test 6 passed: Single dollar signs allowed for currency');
  
  // Test 6b: Currency mixed with LaTeX should work
  const currencyWithLatex = validateLatex('The cost is $10 and the formula is \\(x = 5\\)');
  assert.equal(currencyWithLatex.isValid, true, 'Expected currency mixed with LaTeX to be valid');
  console.log('✓ Test 6b passed: Currency mixed with LaTeX works correctly');
  
  // Test 6c: Multiple dollar signs for currency
  const multipleCurrency = validateLatex('Prices: $5, $10, $15, and $20 are all valid');
  assert.equal(multipleCurrency.isValid, true, 'Expected multiple dollar signs to be valid');
  console.log('✓ Test 6c passed: Multiple currency dollar signs work correctly');
 
  // Test 7: Large text validation from file
  const largeText = readFileSync('./test/large-text.txt', 'utf8');
  if (largeText.trim().length > 0) {
    const largeTextValidation = validateLatex(largeText);
    console.log(`✓ Test 7: Large text validation completed - ${largeTextValidation.isValid ? 'Valid' : `${largeTextValidation.errors.length} errors found`}`);
    if (!largeTextValidation.isValid) {
      console.log('\nErrors found in large text:');
      largeTextValidation.errors.forEach((error, index) => {
        console.log(`  ${index + 1}. ${error.message}`);
        console.log(`     Position: ${error.position}, Type: ${error.type}`);
        console.log(`     LaTeX: ${error.latex}`);
      });
    }
  } else {
    console.log('⚠ Test 7: Skipped - large-text.txt is empty (add your test content)');
  }
  
  console.log('\nAll tests passed!');
}

run();


