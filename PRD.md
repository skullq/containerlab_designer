# Containerlab API - Product Requirements Document

**API Version**: 1.0  
**Base URL**: `http://10.70.136.126:8080`  
**Authentication**: Bearer Token (JWT)

## Overview

The Containerlab API is a REST API server that allows interaction with containerlab for authenticated Linux users. It runs containerlab commands as the API server's user and provides comprehensive lab management, networking, and monitoring capabilities.

---

## Table of Contents

1. [Authentication](#authentication)
2. [Health & Status](#health--status)
3. [Lab Management](#lab-management)
4. [Topology Generation](#topology-generation)
5. [Node Management](#node-management)
6. [SSH Access](#ssh-access)
7. [Network Tools](#network-tools)
8. [User Management](#user-management)
9. [Version Management](#version-management)
10. [Events & Monitoring](#events--monitoring)
11. [NeXt UI Frontend](#next-ui-frontend)

---

## Authentication

### Login
- **Endpoint**: `POST /login`
- **Description**: Authenticates a user and returns a JWT token
- **Request Body**: 
  ```json
  {
    "username": "string",
    "password": "string"
  }
  ```
- **Response**: JWT token for use in subsequent requests
- **Security**: Requires valid PAM credentials
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input
  - 401: Invalid credentials
  - 500: Internal server error

### Authorization
- **Type**: Bearer Token (JWT)
- **Header Format**: `Authorization: Bearer <jwt_token>`
- **Required for**: All API endpoints except `/health` and `/login`

---

## Health & Status

### Get Health Status
- **Endpoint**: `GET /health`
- **Description**: Returns basic health status for the API server
- **Response Fields**:
  - `status`: Health status indicator (e.g., "healthy")
  - `version`: API server version
  - `uptime`: Human-readable uptime
  - `startTime`: Server start time
- **HTTP Status Codes**: 200 (success)

### Get System Metrics
- **Endpoint**: `GET /api/v1/health/metrics`
- **Description**: Returns detailed CPU, memory, and disk metrics
- **Requirements**: Superuser privileges required
- **Response Includes**:
  - **CPU Metrics**:
    - `numCPU`: Number of CPU cores
    - `usagePercent`: Overall CPU usage percentage
    - `processPercent`: This process's CPU usage
    - `loadAvg1`, `loadAvg5`, `loadAvg15`: Load averages
  - **Memory Metrics**:
    - `totalMem`: Total physical memory (bytes)
    - `usedMem`: Used physical memory (bytes)
    - `availableMem`: Available memory (bytes)
    - `usagePercent`: Memory usage percentage
    - `processMemMB`: Process memory (MB)
    - `processMemPct`: Process memory percentage
  - **Disk Metrics**:
    - `totalDisk`: Total disk space (bytes)
    - `usedDisk`: Used disk space (bytes)
    - `freeDisk`: Free disk space (bytes)
    - `usagePercent`: Disk usage percentage
    - `path`: Mount path
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 403: Forbidden (non-superuser)
  - 500: Internal server error

---

## Lab Management

### Deploy Lab
- **Endpoint**: `POST /api/v1/labs`
- **Description**: Deploys a containerlab topology
- **Source Options**:
  - `topologyContent`: Direct YAML content as JSON object
  - `topologySourceUrl`: URL to Git repository or .clab.yml file
- **Query Parameters**:
  - `labNameOverride`: Override lab name when deploying from URL
  - `reconfigure`: Allow overwriting existing lab if owned by user
  - `maxWorkers`: Limit concurrent workers
  - `exportTemplate`: Custom Go template file for topology data export
  - `nodeFilter`: Comma-separated list of node names to deploy
  - `skipPostDeploy`: Skip post-deploy actions
  - `skipLabdirAcl`: Skip setting extended ACLs on lab directory
- **Response**: Deployed lab details
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input
  - 401: Unauthorized
  - 403: Forbidden
  - 409: Conflict (lab already exists)
  - 500: Internal server error

### Deploy Lab from Archive
- **Endpoint**: `POST /api/v1/labs/archive`
- **Description**: Deploys a topology from .zip or .tar.gz archive
- **Request Type**: multipart/form-data
- **Parameters**:
  - `labArchive`: Lab archive file (.zip or .tar.gz)
  - `labName`: Name for the lab (required)
  - `reconfigure`: Allow overwriting existing lab
  - `maxWorkers`: Limit concurrent workers
  - Other parameters same as POST /api/v1/labs
- **Response**: Deployed lab details
- **HTTP Status Codes**: 200, 400, 401, 403, 409, 500

### List All Labs
- **Endpoint**: `GET /api/v1/labs`
- **Description**: Returns details for all running labs
- **Access Control**: Results filtered by owner (non-superusers); superusers see all labs
- **Response**: Array of lab containers with details
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 500: Internal server error

### Inspect Lab
- **Endpoint**: `GET /api/v1/labs/{labName}`
- **Description**: Returns detailed information for a specific running lab
- **Path Parameters**:
  - `labName`: Name of the lab to inspect
- **Response Fields** (per node):
  - `name`: Container node name
  - `lab_name`: Lab name this node belongs to
  - `container_id`: Docker container ID (short)
  - `image`: Container image used
  - `kind`: Node kind (e.g., "linux", "nokia_srlinux")
  - `state`: Container state (e.g., "running")
  - `status`: Human-readable status (e.g., "Up 18 hours")
  - `ipv4_address`: Management IPv4 address/mask
  - `ipv6_address`: Management IPv6 address/mask
  - `group`: Group assigned in topology
  - `owner`: OS user
  - `labPath`: Path to topology file
  - `absLabPath`: Absolute path to topology file
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid lab name
  - 401: Unauthorized
  - 404: Lab not found
  - 500: Internal server error

### Redeploy Lab
- **Endpoint**: `PUT /api/v1/labs/{labName}`
- **Description**: Redeploys a lab by destroying and redeploying it
- **Path Parameters**:
  - `labName`: Name of the lab to redeploy
- **Query Parameters**:
  - `cleanup`: Remove containerlab lab artifacts during destroy
  - `graceful`: Attempt graceful shutdown
  - `keepMgmtNet`: Keep the management network
  - `maxWorkers`: Limit concurrent workers
  - `exportTemplate`: Custom Go template file
  - `skipPostDeploy`: Skip post-deploy actions
  - `skipLabdirAcl`: Skip setting extended ACLs
- **Response**: Redeployed lab details
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid lab name
  - 401: Unauthorized
  - 403: Forbidden
  - 404: Lab not found
  - 500: Internal server error

### Destroy Lab
- **Endpoint**: `DELETE /api/v1/labs/{labName}`
- **Description**: Destroys a lab after verifying ownership
- **Path Parameters**:
  - `labName`: Name of the lab to destroy
- **Query Parameters**:
  - `cleanup`: Remove containerlab lab artifacts
  - `purgeLabDir`: Purge topology parent directory
  - `graceful`: Attempt graceful shutdown
  - `keepMgmtNet`: Keep the management network
  - `nodeFilter`: Destroy only specific nodes
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid lab name
  - 401: Unauthorized
  - 403: Forbidden
  - 404: Lab not found
  - 500: Internal server error

---

## Topology Generation

### Generate Topology
- **Endpoint**: `POST /api/v1/generate`
- **Description**: Generates a containerlab topology from CLOS definitions and optionally deploys it
- **Request Body**:
  - `name`: Lab name (required)
  - `tiers`: Array of tier definitions (required, min 1 tier)
    - `count`: Number of nodes in tier (required)
    - `kind`: Node kind (defaults to 'nokia_srlinux')
    - `type`: Node type within kind
  - `deploy`: Boolean - whether to deploy after generation
  - `defaultKind`: Default node kind
  - `images`: Object mapping node kind to image path
  - `licenses`: Object mapping node kind to license path
  - `ipv4Subnet`: IPv4 subnet (e.g., "172.20.20.0/24")
  - `ipv6Subnet`: IPv6 subnet (e.g., "2001:172:20:20::/64")
  - `nodePrefix`: Prefix for node names
  - `groupPrefix`: Prefix for group names
  - `managementNetwork`: Management network name
  - `maxWorkers`: Concurrent workers limit
  - `outputFile`: File path to save YAML
- **Response Fields**:
  - `message`: Success/failure message
  - `topologyYaml`: Generated YAML (if deploy=false and no outputFile)
  - `savedFilePath`: Path where file was saved
  - `deployOutput`: Deployment output (if deploy=true)
- **Notes**:
  - Deployment denied if lab name already exists
  - When deploy=true, topology saved to user's ~/.clab/<labName>/
  - When deploy=false and outputFile is empty, YAML returned in response
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters
  - 401: Unauthorized
  - 409: Conflict (Lab already exists when deploy=true)
  - 500: Internal server error

---

## Node Management

### Execute Command in Lab
- **Endpoint**: `POST /api/v1/labs/{labName}/exec`
- **Description**: Executes a command on nodes within a lab
- **Path Parameters**:
  - `labName`: Name of the lab
- **Query Parameters**:
  - `nodeFilter`: Execute only on specific node
- **Request Body**:
  ```json
  {
    "command": "ip addr show eth1"
  }
  ```
- **Response**: Execution result per node with:
  - `cmd`: Command and arguments as executed
  - `stdout`: Standard output
  - `stderr`: Standard error
  - `return-code`: Exit code
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input
  - 401: Unauthorized
  - 404: Lab not found
  - 500: Internal server error

### List Lab Interfaces
- **Endpoint**: `GET /api/v1/labs/{labName}/interfaces`
- **Description**: Returns interface details for nodes in a lab
- **Path Parameters**:
  - `labName`: Name of the lab
- **Query Parameters**:
  - `node`: Filter interfaces for specific node
- **Response**: Array of nodes with interface details:
  - `name`: Container node name
  - `interfaces`: Array of interfaces
    - `name`: Interface name (e.g., "eth0", "e1-1")
    - `alias`: Interface alias (e.g., "ethernet-1/1")
    - `state`: Interface state (up/down/unknown)
    - `type`: Interface type (veth/device/dummy)
    - `mac`: MAC address
    - `mtu`: MTU size
    - `ifindex`: Interface index
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid lab name
  - 401: Unauthorized
  - 404: Lab not found
  - 500: Internal server error

### Save Lab Configuration
- **Endpoint**: `POST /api/v1/labs/{labName}/save`
- **Description**: Saves the running configuration for nodes in a lab
- **Path Parameters**:
  - `labName`: Name of the lab
- **Query Parameters**:
  - `nodeFilter`: Save config only for specific nodes
- **Response**: 
  - `message`: Overall success message
  - `output`: Detailed output from 'clab save' command
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input
  - 401: Unauthorized
  - 404: Lab not found
  - 500: Internal server error

---

## SSH Access

### Request SSH Access to Node
- **Endpoint**: `POST /api/v1/labs/{labName}/nodes/{nodeName}/ssh`
- **Description**: Creates temporary SSH access to a lab node
- **Path Parameters**:
  - `labName`: Lab name
  - `nodeName`: Full container name (e.g., "clab-my-lab-srl1")
- **Request Body** (optional):
  ```json
  {
    "duration": "1h",
    "sshUsername": "admin"
  }
  ```
- **Request Fields**:
  - `duration`: Access validity duration (e.g., "1h", "30m")
  - `sshUsername`: Optional SSH username override
- **Response**:
  - `host`: API server hostname/IP
  - `port`: Allocated port
  - `username`: SSH username
  - `command`: Example SSH command
  - `expiration`: When access expires
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid request parameters
  - 401: Unauthorized
  - 403: Forbidden (not owner)
  - 404: Lab or node not found
  - 500: Internal server error

### List SSH Sessions
- **Endpoint**: `GET /api/v1/ssh/sessions`
- **Description**: Returns active SSH sessions
- **Query Parameters**:
  - `all`: If true and user is superuser, shows all users' sessions
- **Response**: Array of SSH sessions:
  - `port`: Allocated port
  - `username`: SSH username
  - `labName`: Lab name
  - `nodeName`: Node name
  - `created`: Creation timestamp
  - `expiration`: Expiration timestamp
- **Access Control**: Regular users see only their sessions; superusers can see all with `all=true`
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 403: Forbidden (non-superuser attempting all sessions)

### Terminate SSH Session
- **Endpoint**: `DELETE /api/v1/ssh/sessions/{port}`
- **Description**: Terminates a specific SSH session by port
- **Path Parameters**:
  - `port`: SSH session port to terminate
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid port parameter
  - 401: Unauthorized
  - 403: Forbidden (not session owner)
  - 404: Session not found
  - 500: Internal server error

---

## Node Logs

### Get Node Logs
- **Endpoint**: `GET /api/v1/labs/{labName}/nodes/{nodeName}/logs`
- **Description**: Returns logs for a lab node
- **Path Parameters**:
  - `labName`: Name of the lab
  - `nodeName`: Full container name
- **Query Parameters**:
  - `tail`: Number of lines from end (default: all) or 'all'
  - `follow`: Stream logs as NDJSON (boolean)
- **Response**:
  - `containerName`: Container name
  - `logs`: Log content (or streaming NDJSON when follow=true)
- **Streaming**: When `follow=true`, response streams as NDJSON with timeout (30 minutes)
- **Access Control**: Owner can view; non-owner gets 403
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input
  - 401: Unauthorized
  - 403: Forbidden (not owner)
  - 404: Lab or node not found
  - 500: Internal server error

---

## Network Tools

### TX Checksum Offload

#### Disable TX Checksum Offload
- **Endpoint**: `POST /api/v1/tools/disable-tx-offload`
- **Description**: Disables TX checksum offload on eth0 of a container
- **Requirements**: Superuser privileges required
- **Request Body**:
  ```json
  {
    "containerName": "clab-my-lab-srl1"
  }
  ```
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 404: Container not found
  - 500: Internal server error

### Network Emulation (Netem)

#### Set Link Impairments
- **Endpoint**: `POST /api/v1/tools/netem/set`
- **Description**: Applies network impairments (delay, jitter, loss, rate limiting, corruption)
- **Requirements**: Superuser privileges
- **Request Body**:
  ```json
  {
    "containerName": "clab-my-lab-srl1",
    "interface": "eth1",
    "delay": "50ms",
    "jitter": "5ms",
    "loss": 10.5,
    "rate": 1000,
    "corruption": 0.1
  }
  ```
- **Parameters**:
  - `containerName`: Container/node name (e.g., "clab-my-lab-srl1")
  - `interface`: Interface name or alias (e.g., "eth1", "mgmt0")
  - `delay`: Duration string (e.g., "100ms", "1s")
  - `jitter`: Duration string (requires Delay)
  - `loss`: Percentage (0.0-100.0)
  - `rate`: Kbit/s (non-negative integer)
  - `corruption`: Percentage (0.0-100.0)
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 404: Container or interface not found
  - 500: Internal server error

#### Reset Link Impairments
- **Endpoint**: `POST /api/v1/tools/netem/reset`
- **Description**: Removes netem impairments from a specific interface
- **Requirements**: Superuser privileges
- **Request Body**:
  ```json
  {
    "containerName": "clab-my-lab-srl1",
    "interface": "eth1"
  }
  ```
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 404: Container or interface not found
  - 500: Internal server error

#### Show Link Impairments
- **Endpoint**: `GET /api/v1/tools/netem/show`
- **Description**: Lists netem impairments for a containerlab node
- **Requirements**: Superuser privileges
- **Query Parameters**:
  - `containerName`: Container/node name (required)
- **Response**: Map of interfaces to impairment details:
  - `interface`: Interface name
  - `delay`: Duration string or empty
  - `jitter`: Duration string or empty
  - `packet_loss`: Percentage
  - `rate`: Kbit/s
  - `corruption`: Percentage (may be missing in older versions)
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 404: Container not found
  - 500: Internal server error

### Virtual Ethernet (vEth)

#### Create vEth Pair
- **Endpoint**: `POST /api/v1/tools/veth`
- **Description**: Creates a virtual Ethernet pair between two endpoints
- **Requirements**: Superuser privileges
- **Request Body**:
  ```json
  {
    "aEndpoint": "clab-demo-node1:eth1",
    "bEndpoint": "clab-demo-node2:eth1",
    "mtu": 1500
  }
  ```
- **Parameters**:
  - `aEndpoint`: Endpoint A definition (format: `<node>:<interface>` or `<kind>:<node>:<interface>`)
  - `bEndpoint`: Endpoint B definition (same format)
  - `mtu`: MTU for vEth pair (defaults to 9500)
- **Supported Endpoint Kinds**:
  - container nodes
  - `bridge:` (Linux bridge)
  - `ovs-bridge:` (Open vSwitch bridge)
  - `host:` (Host namespace)
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid endpoint parameters
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 500: Internal server error (clab execution failed)

### VxLAN Tunneling

#### Create VxLAN Tunnel
- **Endpoint**: `POST /api/v1/tools/vxlan`
- **Description**: Creates a VxLAN tunnel interface with tc rules for traffic redirection
- **Requirements**: Superuser privileges
- **Request Body**:
  ```json
  {
    "link": "srl_e1-1",
    "remote": "10.0.0.20",
    "id": 100,
    "port": 4789,
    "mtu": 1400,
    "dev": "eth0"
  }
  ```
- **Parameters**:
  - `link`: Existing interface in root namespace (required)
  - `remote`: Remote VTEP IP address (required)
  - `id`: VxLAN Network Identifier (VNI), defaults to 10
  - `port`: UDP port, defaults to 14789
  - `mtu`: MTU for VxLAN interface (auto-calculated if omitted)
  - `dev`: Linux device for tunnel source (auto-detected if omitted)
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters (remote, link, id, port)
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 500: Internal server error (clab execution failed)

#### Delete VxLAN Tunnels
- **Endpoint**: `DELETE /api/v1/tools/vxlan`
- **Description**: Deletes VxLAN tunnel interfaces matching a prefix
- **Requirements**: Superuser privileges
- **Query Parameters**:
  - `prefix`: Prefix of VxLAN interfaces to delete (default: "vx-")
- **Response**: Success message (count of deleted tunnels)
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid prefix format
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 500: Internal server error (clab execution failed)

---

## Certificates & CA Tools

### Create Certificate Authority (CA)
- **Endpoint**: `POST /api/v1/tools/certs/ca`
- **Description**: Creates a CA certificate and private key
- **Requirements**: Superuser privileges
- **Request Body**:
  ```json
  {
    "name": "my-root-ca",
    "commonName": "ca.example.com",
    "organization": "MyOrg",
    "orgUnit": "IT",
    "country": "US",
    "locality": "City",
    "expiry": "8760h"
  }
  ```
- **Parameters** (all optional except name):
  - `name`: CA name (defaults to "ca" if empty), used for filenames
  - `commonName`: CN field (defaults to "containerlab.dev")
  - `organization`: O field (defaults to "Containerlab")
  - `orgUnit`: OU field (defaults to "Containerlab Tools")
  - `country`: C field (defaults to "Internet")
  - `locality`: L field (defaults to "Server")
  - `expiry`: Duration string (defaults to "87600h" = 10 years)
- **Storage**: Files stored in `~/.clab/certs/<ca_name>/` on server
- **Response**:
  - `message`: Success message
  - `keyPath`: Path to CA key file
  - `certPath`: Path to CA cert file
  - `csrPath`: Path to CSR file
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 500: Internal server error

### Sign Certificate
- **Endpoint**: `POST /api/v1/tools/certs/sign`
- **Description**: Signs a certificate/key with a previously generated CA
- **Requirements**: Superuser privileges
- **Request Body**:
  ```json
  {
    "caName": "my-root-ca",
    "name": "node1.example.com",
    "commonName": "node1.example.com",
    "hosts": ["node1.example.com", "10.0.0.1"],
    "keySize": 2048,
    "organization": "MyOrg",
    "orgUnit": "Nodes",
    "country": "US",
    "locality": "City"
  }
  ```
- **Parameters**:
  - `caName`: Name of CA cert/key to sign with (required)
  - `name`: Certificate name (required), used for filenames
  - `commonName`: CN field (defaults to Name if empty)
  - `hosts`: Array of SANs (DNS names or IPs, required)
  - `keySize`: Bits (defaults to 2048)
  - `organization`: O field (defaults to "Containerlab")
  - `orgUnit`: OU field (defaults to "Containerlab Tools")
  - `country`: C field (defaults to "Internet")
  - `locality`: L field (defaults to "Server")
- **Storage**: Files stored in `~/.clab/certs/<ca_name>/` directory
- **Response**:
  - `message`: Success message
  - `keyPath`: Path to certificate key file
  - `certPath`: Path to certificate file
  - `csrPath`: Path to CSR file
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid input parameters (name, hosts, CA name)
  - 401: Unauthorized (JWT)
  - 403: Forbidden (not superuser)
  - 404: Specified CA not found
  - 500: Internal server error

---

## User Management

### List Users
- **Endpoint**: `GET /api/v1/users`
- **Description**: Returns a list of system users
- **Requirements**: Superuser privileges required
- **Response**: Array of user objects:
  - `username`: System username
  - `uid`: User ID
  - `gid`: Group ID
  - `displayName`: Full name from GECOS field
  - `homeDir`: Home directory
  - `shell`: Login shell
  - `isApiUser`: API-related flag
  - `isSuperuser`: Superuser flag
  - `groups`: Array of group memberships
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 500: Internal server error

### Create User
- **Endpoint**: `POST /api/v1/users`
- **Description**: Creates a new system user
- **Requirements**: Superuser privileges required
- **Request Body**:
  ```json
  {
    "username": "newuser",
    "password": "secure_password",
    "displayName": "New User",
    "shell": "/bin/bash",
    "isSuperuser": false,
    "groups": ["group1", "group2"]
  }
  ```
- **Parameters** (username and password required):
  - `username`: System username (required)
  - `password`: User password (required)
  - `displayName`: Full name
  - `shell`: Login shell (defaults to /bin/bash if empty)
  - `isSuperuser`: Superuser privileges flag
  - `groups`: Group memberships array
- **Response**: Success message
- **HTTP Status Codes**: 
  - 201: Created successfully
  - 400: Invalid request body
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 409: User already exists
  - 500: Internal server error

### Get User Details
- **Endpoint**: `GET /api/v1/users/{username}`
- **Description**: Returns details for a specific user
- **Requirements**: Superuser or the user's own account
- **Path Parameters**:
  - `username`: Username to get details for
- **Response**: User details object
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 403: Forbidden (not superuser or not own account)
  - 404: User not found
  - 500: Internal server error

### Update User
- **Endpoint**: `PUT /api/v1/users/{username}`
- **Description**: Updates an existing user
- **Requirements**: Superuser or user's own account
- **Path Parameters**:
  - `username`: Username to update
- **Request Body**:
  ```json
  {
    "displayName": "Updated Name",
    "shell": "/bin/zsh",
    "isSuperuser": true,
    "groups": ["newgroup"]
  }
  ```
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid request body
  - 401: Unauthorized
  - 403: Forbidden (not superuser or not own account)
  - 404: User not found
  - 500: Internal server error

### Change User Password
- **Endpoint**: `PUT /api/v1/users/{username}/password`
- **Description**: Changes a user's password
- **Requirements**: Superuser or user's own account
- **Path Parameters**:
  - `username`: Username to change password for
- **Request Body**:
  ```json
  {
    "currentPassword": "old_password",
    "newPassword": "new_password"
  }
  ```
- **Parameters**:
  - `currentPassword`: Required if not superuser
  - `newPassword`: New password (required)
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 400: Invalid request body
  - 401: Unauthorized or incorrect current password
  - 403: Forbidden (not superuser or not own account)
  - 404: User not found
  - 500: Internal server error

### Delete User
- **Endpoint**: `DELETE /api/v1/users/{username}`
- **Description**: Deletes a user from the system
- **Requirements**: Superuser privileges required
- **Path Parameters**:
  - `username`: Username to delete
- **Response**: Success message
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 403: Forbidden (not superuser)
  - 404: User not found
  - 500: Internal server error

---

## Version Management

### Get Containerlab Version
- **Endpoint**: `GET /api/v1/version`
- **Description**: Returns version information for the containerlab library
- **Response**:
  - `versionInfo`: Raw output from `clab version` command
    - Includes: version number, commit hash, date, GitHub URL, release notes
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized
  - 500: Internal server error

### Check for Updates
- **Endpoint**: `GET /api/v1/version/check`
- **Description**: Checks whether a newer containerlab release is available
- **Response**:
  - `checkResult`: Raw output from `clab version check`
- **Response Example** (if update available):
  ```
  🎉 A newer containerlab version (0.62.2) is available!
  Release notes: https://containerlab.dev/rn/0.62/#0622
  Run 'sudo clab version upgrade' or see https://containerlab.dev/install/
  ```
- **HTTP Status Codes**: 
  - 200: Success
  - 401: Unauthorized

---

## Events & Monitoring

### Stream Containerlab Events
- **Endpoint**: `GET /api/v1/events`
- **Description**: Streams containerlab events in real-time as NDJSON
- **Response Format**: NDJSON (one JSON object per line), connection stays open until client disconnects
- **Query Parameters**:
  - `initialState`: Include initial snapshot events (boolean, default: false)
  - `interfaceStats`: Include interface stats events (boolean, default: false)
  - `interfaceStatsInterval`: Interval for stats collection (e.g., "10s", default: "10s")
    - Requires `interfaceStats=true`
- **Event Types**:
  - `container`: Container lifecycle events (start, stop, die, etc.)
  - `interface-stats`: Interface statistics when enabled
- **Example Event**:
  ```json
  {
    "time": 1706918400,
    "type": "container",
    "action": "start",
    "attributes": {
      "name": "clab-mylab-srl1",
      "lab": "mylab",
      "clab-node-name": "srl1",
      "clab-node-kind": "nokia_srlinux",
      "image": "ghcr.io/nokia/srlinux:latest"
    }
  }
  ```
- **Interface Stats Example**:
  ```json
  {
    "time": 1706918410,
    "type": "interface-stats",
    "action": "stats",
    "attributes": {
      "name": "clab-mylab-srl1",
      "lab": "mylab",
      "interface": "e1-1",
      "rx_bytes": 123456,
      "tx_bytes": 654321
    }
  }
  ```
- **Event Attributes**:
  - `name`: Container name (e.g., "clab-mylab-srl1")
  - `lab`: Lab name
  - `clab-node-name`: Node name within lab
  - `clab-node-kind`: Node kind (e.g., "nokia_srlinux", "linux")
  - `clab-node-type`: Node type (e.g., "ixrd3")
  - `image`: Container image
  - `exitCode`: Exit code (for stop/die events)
  - Interface stats: `rx_bytes`, `tx_bytes`, `interface`
- **HTTP Status Codes**: 
  - 200: Stream established
  - 400: Invalid input
  - 401: Unauthorized
  - 500: Internal server error

---

## Error Handling

### Standard Error Response
All error responses follow this format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### Common HTTP Status Codes
- **200**: Success
- **201**: Created successfully
- **400**: Bad request - invalid input parameters
- **401**: Unauthorized - missing or invalid authentication
- **403**: Forbidden - insufficient permissions
- **404**: Not found - resource doesn't exist
- **409**: Conflict - resource already exists or state conflict
- **500**: Internal server error - server-side issue

---

## Authentication & Authorization

### Privileges
- **Regular Users**:
  - Can manage their own resources (labs, SSH sessions)
  - Cannot access other users' resources
  - Cannot access superuser-only endpoints

- **Superusers**:
  - Can manage all resources
  - Can access system metrics and user management
  - Can perform tool operations (netem, vEth, VxLAN, certificates)
  - Can view all SSH sessions

### Resource Ownership
- Labs are owned by the user who deployed them
- SSH sessions are owned by the user who created them
- Only owners can destroy or access their resources (except superusers)

---

## Usage Examples

### Deploy a Lab
```bash
curl -X POST http://10.70.136.126:8080/api/v1/labs \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d'{
    "topologyContent": {
      "name": "my-lab",
      "topology": {
        "kinds": {
          "nokia_srlinux": {"type": "ixrd3", "image": "ghcr.io/nokia/srlinux"}
        },
        "nodes": {
          "srl1": {"kind": "nokia_srlinux"},
          "srl2": {"kind": "nokia_srlinux"}
        },
        "links": [{
          "endpoints": ["srl1:e1-1", "srl2:e1-1"]
        }]
      }
    }
  }'
```

### Execute Command on Node
```bash
curl -X POST http://10.70.136.126:8080/api/v1/labs/my-lab/exec \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d'{"command": "show ip interface brief"}'
```

### Stream Events
```bash
curl -N http://10.70.136.126:8080/api/v1/events \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Accept: application/x-ndjson"
```

---

## Notes

- PAM authentication is required
- All timestamps are in Unix epoch format
- YAML files can be provided as JSON objects in API requests
- The API runs commands as the authenticated user

---

## NeXt UI Frontend

### Overview
The NeXt UI is an interactive topology visualization and management interface built with the NeXt.js library. It provides real-time visualization of network topology with intuitive node manipulation, tooltip interactions, and drag-and-drop node repositioning.

### Architecture

#### Core Components
- **NeXt.js Library** (`next_sources/js/next.js`): Topology rendering engine with built-in scene management, force layout, and event dispatching
- **next_app_v2.js**: Main application logic handler for user interactions, state management, and NeXt integration
- **HTML UI** (`main_api_v2.html`): Host page with tabbed interface for topology editing, server authentication, and development tools

#### State Management

**Global State Variables** (in next_app_v2.js):
```javascript
activeSelectedNodeId          // Currently focused node ID
pendingNodeDrag               // Drag state object with {nodeId, startClientX, startClientY, startTs, tooltipHidden}
pendingBackgroundClick        // Background click detection state
backgroundPanState            // Pan mode tracking state
lastNodePrimaryDown           // Double-click detection for nodes
lastNodeOpenRequest           // Deduplication for tooltip opens
```

### Interaction Model

#### 1. Node Click Interaction
**Flow**: `handleDocumentPointerDown` → `getNodeIdFromEventTarget` → `handleNodePrimaryClick` → `openNodeStatusWindowOnce`

**Details**:
- **Detection Phase**: User clicks on node (mousedown event)
- **Node Resolution**: 
  - Primary: DOM selector (`.node, .nodeset, .nodeSet`)
  - Fallback: Proximity lookup using `findNearestNodeByClientPoint` with `INTERACTION.focusPickRadius` (56px)
- **Focus Action**: 
  - Sets `activeSelectedNodeId` 
  - Applies visual highlight via `applyNodeFocusHighlight` (dims non-connected nodes/links)
  - Updates status panel with node details
- **Tooltip Action**: 
  - Calls `openNodeStatusWindow` via NeXt's `tooltipManager().openNodeTooltip(node)`
  - Includes node info: name, IP address, kind, state, connectivity
- **Deduplication**: 140ms window to prevent rapid duplicate opens

**Console Output**: Node details display, focus highlight applied

#### 2. Node Drag Interaction
**Flow**: `handleDocumentPointerDown` (sets `pendingNodeDrag`) → NeXt's `dragNode` event → tooltip closes → NeXt's `dragNodeEnd` event → tooltip reopens

**Details**:
- **Drag Detection**:
  - NeXt detects native node drag and fires `dragNode` event (every mousemove)
  - User moves node in canvas while button held
- **Tooltip Handling**:
  - On `dragNode`: Calls `topo.tooltipManager().closeAll()` to hide tooltip
  - On `dragNodeEnd`: Calls `topo.tooltipManager().openNodeTooltip(node)` at final position
- **Position Persistence**:
  - Final node coordinates captured on mouseup via `queueSaveNodePositions(140ms)`
  - Automatically synced to server and localStorage
- **Interaction State**: Node position tracked in NeXt scene; UI remains responsive

#### 3. Background Click & Drag Interaction
**Flow**: 
- **Focused State**: Click on background → `handleDocumentPointerDown` clears focus (sets `activeSelectedNodeId = null`) + closes tooltip
- **Unfocused State**: Click on background → enters pan mode

**Pan Mode Details**:
- **Initialization**: `startBackgroundPanTracking()` enables window-level `mousemove`/`mouseup` listeners
- **Drag Detection**: 7px threshold (`INTERACTION.backgroundDragStartPx`) to distinguish click from drag
- **Pan Action**: Each mousemove calls `stage.applyTranslate(dxPan, dyPan)` to update viewport
- **Cursor Feedback**: Move cursor shown during pan mode via `setBackgroundMoveCursor(true)`
- **Cleanup**: `stopBackgroundPanTracking()` removes listeners, resets cursor

**Behavior Summary**:
```
State: Focused (node selected)
  → Background Click: Clear focus, close tooltip, NO pan
  → Background Drag: Clear focus, close tooltip, NO pan

State: Unfocused (no node selected)
  → Background Click: Single click only, no pan
  → Background Drag: Pan mode enabled, move viewport
```

### Tooltip Management

#### openNodeStatusWindow(node)
```javascript
function openNodeStatusWindow(node) {
    if (!node || !node.model) return;
    showNodeDetails(node.model());          // Update side panel
    updateStatusPanel();                    // Refresh status indicators
    if (topo && typeof topo.tooltipManager === 'function') {
        try {
            topo.tooltipManager().openNodeTooltip(node);  // Show NeXt tooltip
        } catch (e) {}
    }
}
```
- Opens both detail panel and NeXt tooltip
- Tooltip position tracked relative to node by NeXt
- Automatically repositioned during viewport changes

#### Tooltip Content
The tooltip displays:
- **Node Name**: With node coordinates (debug)
- **Management IP**: Dynamically assigned from pool 172.31.255.x
- **Kind**: Node type (e.g., nokia_srlinux, linux, ceos)
- **State**: Container state (running/stopped)
- **Connectivity**: List of connected peer nodes and interface names

**Data Sources**:
- NeXt model data (kind, node.model().getData())
- Runtime node state from last topology fetch
- Connectivity computed from link traversal

### Event Handling Architecture

#### Document-Level Events
```javascript
document.addEventListener('mousedown', handleDocumentPointerDown, false)  // Node/bg detection
document.addEventListener('mousemove', handleDocumentPointerMove, false)  // Pan tracking
document.addEventListener('click', handleDocumentClick, false)            // Post-click cleanup
document.addEventListener('dblclick', handleDocumentDoubleClick, false)   // Node focus via double-click
document.addEventListener('mouseup', handleDocumentPointerUp, false)      // Drag completion
document.addEventListener('contextmenu', handleDocumentContextMenu, true) // Right-click menu
```

#### NeXt Event Subscriptions
```javascript
topo.on('clickNode', ...)           // Primary node interaction
topo.on('dblclickNode', ...)        // Double-click node focus
topo.on('dragNode', ...)            // Hide tooltip during drag
topo.on('dragNodeEnd', ...)         // Reopen tooltip at final position
topo.on('clickLink', ...)           // Link mode selection
topo.on('contextmenu', ...)         // Context menu (right-click)
```

### Performance Optimizations

#### Batched DOM Updates
- Focus highlight applied via `requestAnimationFrame` to minimize reflows
- Single pass through all nodes/links for class updates (`.topo-focal`, `.topo-dim`)
- Classes removed in batch when focus cleared

#### Deduplication
- `lastNodeOpenRequest`: Prevents tooltip spam within 140ms
- `lastNodePrimaryDown`: Double-click detection with 340ms window
- `lastLinkPick`: Link mode click deduplication

#### Viewport Management
- Snapshot auto-save to localStorage on every drag completion (140ms debounced)
- Background pan uses `stage.applyTranslate` for direct viewport transform
- No forced layout recalculations during pan

### Configuration Constants

```javascript
INTERACTION = {
    contextPickRadius: 80,           // Right-click proximity radius
    linkPickRadius: 68,              // Link selection radius
    focusPickRadius: 56,             // Node focus radius
    doubleClickPickRadius: 30,       // Double-click detection
    doubleClickMs: 340,              // Double-click time window
    dedupeMs: 120,                   // Deduplication window
    suppressClickNodeMs: 200,        // Click suppression during animation
    backgroundDragStartPx: 7,        // Pan mode engagement threshold
    nodeDragHideTooltipPx: 12        // Reserved (managed via NeXt events)
}
```

### UI Tabs

#### Topology Tab (Default)
- Node/link editing controls
- Lab lifecycle buttons (Deploy, Destroy, Refresh)
- Run Command button

#### Server Auth Tab
- Remote containerlab API connection
- JWT token persistence
- System metrics polling (CPU, Memory)
- Health check integration

#### Develop Tab
- Kind → Image Registry mapping (persistent in localStorage)
- API Tester interface
- Debug Hit Test overlay
- Health and metrics endpoints

### Data Persistence

#### Local Storage Keys
- `next_ui.layout.<lab_id>`: Node position map per lab
- `next_ui.kind_image_registry`: Kind-to-image mappings (JSON object)
- `next_ui.topology_snapshot.v1`: Full graph snapshot for offline access
- `next_ui.remote_server_url`: Remote API URL
- `next_ui.remote_token`: Cached JWT token

#### Server Sync
- Node positions: `PUT /api/clab/labs/{lab_id}/layout`
- Layout retrieval: `GET /api/clab/labs/{lab_id}/layout` (on init)

### Known Limitations

1. **Viewport Restore**: Initial viewport transform disabled to avoid NeXt force layout conflicts
2. **Tooltip Positioning**: Relies on NeXt's internal positioning logic; may overlap on dense topologies
3. **Pan Mode**: Not available when node is focused (consistent UX design)
4. **Proximity Lookup**: 56px radius may select wrong node in very dense layouts (use direct click)

### Future Enhancements

- [ ] Animated transitions for tooltip open/close
- [ ] Keyboard shortcuts (Delete, Ctrl+A for select all)
- [ ] Multi-select drag for batch operations
- [ ] Undo/Redo stack for edits
- [ ] Export topology as PNG/SVG
- [ ] Collaborative editing (real-time sync via WebSocket)

### User Validation Checklist

#### Pre-Deploy
- Connect to the remote server from the Server Auth tab with valid server URL, username, and password
- Confirm the Remote API indicator changes to Connected
- Enter the intended lab name in the Topology tab before deployment
- Build nodes and links, then open YAML export and confirm the generated topology looks correct
- For xrd nodes, confirm link endpoints use the `Gi0-0-0-x` format

#### Deploy Flow
- Click Deploy and confirm a success message is shown
- Confirm the Lab status indicator shows the deployed lab name
- Confirm the Lab status indicator reports a running or otherwise healthy state
- Click Refresh and confirm the deployed lab is still discovered from the server
- Confirm the topology view is populated from the deployed lab data

#### Lab Status Flow
- Click Lab Status and confirm the current lab state is refreshed from the server
- Confirm the status summary includes lab name and node counts
- Enter a non-existent lab name and confirm the UI reports not found
- Confirm authentication or server errors are surfaced clearly to the user

#### Destroy Flow
- Click Destroy on a deployed lab and confirm a delete confirmation dialog appears
- Confirm a success message appears after deletion
- Confirm the Lab status indicator changes to destroyed or no running labs
- Click Refresh and confirm the deleted lab is no longer listed by the server
- Redeploy the same lab name and confirm the previous deletion did not leave a blocking conflict

#### Error Handling
- Confirm invalid login credentials show a clear authentication failure message
- Confirm missing server configuration shows a clear server-side error message
- Confirm destroy failures surface the returned reason to the user
- Confirm remote 400 and 500 responses are visible in the UI with actionable detail when available

