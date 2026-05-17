#!/bin/bash

# Hosted Dashboard Setup Script
# This script installs the Hosted Dashboard as a systemd service.

set -e

APP_DIR="/home/ayman/hosted-dashboard"
SERVICE_NAME="hosted-dashboard"
NODE_PATH=$(which node)

if [ -z "$NODE_PATH" ]; then
    echo "Error: node is not installed or not in PATH."
    exit 1
fi

echo "Creating systemd service file..."

cat <<EOF | sudo tee /etc/systemd/system/$SERVICE_NAME.service
[Unit]
Description=Hosted Dashboard Discovery Service
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR/backend
ExecStart=$NODE_PATH index.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=80

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "Enabling and starting $SERVICE_NAME service..."
sudo systemctl enable $SERVICE_NAME
sudo systemctl restart $SERVICE_NAME

echo "------------------------------------------------"
echo "Setup Complete!"
echo "The dashboard should now be available at http://localhost"
echo "Check status with: systemctl status $SERVICE_NAME"
echo "------------------------------------------------"
