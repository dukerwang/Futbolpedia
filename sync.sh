#!/bin/bash

# Exit on error
set -e

echo "===================================================="
echo "🔄 FUTBOLPEDIA AUTOMATIC GITHUB SYNC"
echo "===================================================="

echo "🚀 Step 1: Pulling latest code from dukerwang/Futbolpedia..."
npx -y degit dukerwang/Futbolpedia . --force

echo "📦 Step 2: Ensuring all dependencies are installed..."
npm install

echo "🛠️ Step 3: Compiling the applet to verify the build..."
npm run build

echo "===================================================="
echo "✅ Sync completed successfully! Your workspace is up to date."
echo "===================================================="
