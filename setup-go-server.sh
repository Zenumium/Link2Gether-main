#!/bin/bash
# Script to install Gorilla WebSocket package and run the Go server

# Check if Go is installed
if ! command -v go &> /dev/null
then
    echo "Go could not be found. Please install Go first: https://golang.org/dl/"
    exit 1
fi

# Initialize Go module if not already initialized
if [ ! -f go.mod ]; then
    go mod init beatit-chatserver
fi

# Get Gorilla WebSocket package
go get github.com/gorilla/websocket

# Run the Go server
go run server.go
