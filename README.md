# Unreal Engine Remote Execution
NodeJS module for connecting to Unreal Engine and running Python commands/code.

## Notes

This requires the _"Python Editor Script Plugin"_ to be enabled, and _"Enable Remote Execution?"_ to be ticked in the project settings.

In this API Unreal Engine instances are referred to as _"nodes"_.

## Examples

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


### Connecting to a spesific Unreal Engine instance
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