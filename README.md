# Go-NetSpeed
A single file speedtest utility

## Usage
Run the executable, allow firewall access as needed, test connections at http://SERVER:8080

### Command line options
| Flag | Description | Default Value |
| -- | -- | -- |
| port  | The port to run the server on. | 8080 |
| maxDownloadSize  | Maximum download size in MB (capped at 1024 MB). | 100 |
| downloadChunkSize  |  Download chunk size in bytes, lower it for lower RAM utilization | 1048576 |
| verbose  |  Pass -verbose to get connection messages | false |