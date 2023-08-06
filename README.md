# Unreal Engine Remote Execution
NodeJS module for connecting to Unreal Engine and running Python commands/code.

## Notes

In this API Unreal Engine instances are referred to as _"nodes"_.

## Examples

### Running a command on the first remote node found
```typescript
import { RemoteExecution } from 'unreal-remote-execution';

const remoteExecution = new RemoteExecution();

// Start the remote execution server, this will start looking for remote nodes
remoteExecution.start();

// Get the first remote node found, with a timeout of 5 seconds
remoteExecution.getFirstRemoteNode(5000).then(
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
    }
);
```


### Connecting to a spesific Unreal Engine instance
```typescript
import { RemoteExecution } from 'unreal-remote-execution';

const remoteExecution = new RemoteExecution();

// Add a listener that is called when a node is found
remoteExecution.events.addEventListener('nodeFound', async (node) => {
    // Check if e.g. the project name matches
    if (node.data.project_name === "My Project") {
        await remoteExecution.openCommandConnection(node);
        
        // code continues here...
    }
});

// Start looking for remote nodes
remoteExecution.start();
```


_*This is a third-party module and is not associated with Epic Games or Unreal Engine in any way._