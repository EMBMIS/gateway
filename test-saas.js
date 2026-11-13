async function test() {
    console.log("=== Testing SaaS Multi-Tenancy ===");
    
    // 1. Fetch available Workspaces
    const res = await fetch('http://localhost:3000/api/projects');
    const projects = await res.json();
    console.log(`[+] Found ${projects.length} Workspaces`);
    
    // 2. Create a new project for isolation test
    const res2 = await fetch('http://localhost:3000/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'External Client B' })
    });
    const p2 = await res2.json();
    console.log(`[+] Created new Workspace: ${p2.name} (Key: ${p2.apiKey})`);
    
    console.log("\n[+] Testing SaaS Agent auto-registration on External Client B Workspace");
    
    // Use raw fetch for Gateway test
    const req1 = await fetch('http://localhost:3000/api/gateway/execute', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${p2.apiKey}`
        },
        body: JSON.stringify({ agentName: 'ClientB-OpsBot', tool: 'db.query', action: 'READ', args: {} })
    });
    const result = await req1.json();
    console.log('[!] Gateway Execution Result:');
    console.log(JSON.stringify(result, null, 2));

    console.log("\n[+] Testing isolation: Fetch agents for new project via dashboard API");
    const req2 = await fetch(`http://localhost:3000/api/agents?projectId=${p2.id}`);
    const agents = await req2.json();
    console.log(`[!] Found ${agents.length} agents in ${p2.name}:`, agents.map(a => a.name));
}

test();
