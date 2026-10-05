```bash
#!/bin/bash

# Check if stellar-cli version is greater than or equal to 25.2
if ! hash stellar-cli 2>/dev/null || ! stellar-cli --version | grep -q "25.2"; then
    echo "Stellar-cli version is less than 25.2. Please update stellar-cli to version 25.2 or higher."
    exit 1
fi

# Build Stellar contract
stellar contract build --target wasm32v1-none --path contracts/streaming-payments

# Deploy to local sandbox network
stellar sandbox serve --path contracts/streaming-payments

# Install dependencies for frontend
npm ci

# Write contract ID to .env.local
echo "STEERING_CONTRACT_ID=$(stellar contract id --path contracts/streaming-payments)" > .env.local

# Optional: Add local configuration if needed
echo "STEERING_CONTRACT_ID=$(stellar contract id --path contracts/streaming-payments)" >> .env.local
```