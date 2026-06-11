import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execPromise = promisify(exec);

/**
 * Executes a shell command on a remote server via SSH.
 * Supports both Password (via sshpass) and Private Key authentication.
 * @param {string} command Command to run
 * @param {Object} connectionConfig SSH credentials
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function executeRemoteCommand(command, connectionConfig) {
  const host = connectionConfig.sshHost;
  const user = connectionConfig.sshUser;
  const port = connectionConfig.sshPort || '22';
  const password = connectionConfig.sshPassword || '';
  const privateKey = connectionConfig.sshPrivateKey || '';

  if (!host || !user) {
    throw new Error('SSH Host and SSH User are required to run remote commands.');
  }

  let keyFilePath = '';
  let commandPrefix = '';

  try {
    // If Private Key is provided, write it to a temporary secure file inside the container
    if (privateKey.trim()) {
      const tempKeyDir = '/tmp/ssh_keys';
      await fs.mkdir(tempKeyDir, { recursive: true });
      keyFilePath = path.join(tempKeyDir, `key_${Date.now()}`);
      
      // Ensure the key content ends with a newline
      const formattedKey = privateKey.trim() + '\n';
      await fs.writeFile(keyFilePath, formattedKey, { mode: 0o600 });
      
      commandPrefix = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${keyFilePath} -p ${port} ${user}@${host}`;
    } 
    // If Password is provided, use sshpass
    else if (password) {
      commandPrefix = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${user}@${host}`;
    } 
    // Otherwise, try standard passwordless key auth (e.g. if container is configured with default keys)
    else {
      commandPrefix = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${user}@${host}`;
    }

    // Escape the remote command to be executed safely
    const escapedCommand = command.replace(/"/g, '\\"');
    const fullCommand = `${commandPrefix} "${escapedCommand}"`;

    console.log(`Executing remote SSH command on ${host} for user ${user}...`);
    const { stdout, stderr } = await execPromise(fullCommand);
    
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      code: 0
    };
  } catch (error) {
    console.error('Remote SSH Execution error:', error.message);
    return {
      stdout: '',
      stderr: error.message,
      code: error.code || 1
    };
  } finally {
    // Clean up temporary private key file immediately for security
    if (keyFilePath) {
      try {
        await fs.unlink(keyFilePath);
      } catch (err) {
        console.error('Failed to delete temporary key file:', err);
      }
    }
  }
}
