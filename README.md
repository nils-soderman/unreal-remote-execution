# Unreal Engine Remote Execution
NodeJS module for connecting to Unreal Engine and running Python commands/code.


## Setup

1. Enable the Unreal Engine Plugin _"Python Editor Script Plugin"_ in your project
2. In Project Settings → Plugins → Python, tick the _"Enable Remote Execution?"_ checkbox 

### Linux

Linux requires additional setup before use

1. **Allow multicast traffic between local processes**
   ```bash
   sudo ip route add 239.0.0.1 dev lo
   ```
   With `239.0.0.1` being the IP configured as the "Multicast Group Endpoint" in Unreal Engine's Python project settings.
   > [!NOTE] This route is not persistent and must be re-run after each reboot.

2. **Set Unreal's Multicast Bind Address to `0.0.0.0`:**  
   Project Settings → Plugins → Python → Python Remote Execution → Advanced → Multicast Bind Address → `0.0.0.0`


## Examples

In this API Unreal Engine instances are referred to as _"nodes"_.

### Running a command on the first remote node found
```typescript
import { RemoteExecution } from 'unreal-remote-execution';

const remoteExecution = new RemoteExecution();

// Start the remote execution server
remoteExecution.start();

// This will start searching for nodes and return the first node found, it'll send a new ping every 1 second, with a timeout of 5 seconds
remoteExecution.getFirstRemoteNode(1000, 5000).then(
    async (node) => {
        // Once a node is found, open a command connection
        // this will allow us to run commands on that node
        await remoteExecution.openCommandConnection(node);
        
        // Execute a command
        const result = await remoteExecution.runCommand('print("Hello World")');
        console.log(result);

        // Close down the servers & connections once we are done
        remoteExecution.stop();
    },
    () => {
        console.log("No remote nodes found!");
        remoteExecution.stop();
    }
);
```


### Connecting to a specific Unreal Engine instance
```typescript
import { RemoteExecution } from 'unreal-remote-execution';

const remoteExecution = new RemoteExecution();
remoteExecution.start();

// Add a listener that is called when a node is found
remoteExecution.events.addEventListener('nodeFound', async (node) => {
    // Check if e.g. the project name matches
    if (node.data.project_name === "My Project") {
        await remoteExecution.openCommandConnection(node);
        
        // code continues here...
    }
});

// Start searching for remote nodes
remoteExecution.startSearchingForNodes();
```


_*This is a third-party module and is not associated with Epic Games or Unreal Engine in any way._