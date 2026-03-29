"""
clab-api-server client wrapper.
Can use real API endpoint or fall back to mock for development.
"""

from typing import Optional, List, Dict, Any
from enum import Enum
import httpx
from datetime import datetime

from models.topology import (
    TopologySpec, RuntimeLabState, ImageInfo, VersionInfo
)


class APIMode(str, Enum):
    """API operation mode"""
    REAL = "real"
    MOCK = "mock"


class ClabAPIClient:
    """
    Client for clab-api-server communication.
    Supports both real API calls and mock mode for development.
    """

    def __init__(
        self,
        mode: APIMode = APIMode.MOCK,
        base_url: str = "http://localhost:8001",
        auth_token: Optional[str] = None
    ):
        self.mode = mode
        self.base_url = base_url
        self.auth_token = auth_token
        self.http_client = httpx.AsyncClient(
            base_url=base_url,
            headers=self._get_headers()
        )
        
        # Import mock server if in mock mode
        if mode == APIMode.MOCK:
            from clab.mock_server import get_mock_server
            self.mock_server = get_mock_server()
        else:
            self.mock_server = None

    def _get_headers(self) -> Dict[str, str]:
        """Get common HTTP headers"""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return headers

    async def authenticate(self, username: str, password: str) -> Dict[str, Any]:
        """Mock/Real: Auth endpoint - obtain JWT token"""
        if self.mode == APIMode.MOCK:
            return {
                "access_token": f"mock-token-{datetime.now().timestamp()}",
                "refresh_token": f"mock-refresh-{datetime.now().timestamp()}",
                "token_type": "bearer",
                "expires_in": 3600
            }
        else:
            response = await self.http_client.post(
                "/auth/login",
                json={"username": username, "password": password}
            )
            response.raise_for_status()
            return response.json()

    async def get_images(self) -> List[ImageInfo]:
        """API: GET /api/v1/images - List available container images"""
        if self.mode == APIMode.MOCK:
            images = self.mock_server.get_images()
            return images
        else:
            response = await self.http_client.get("/api/v1/images")
            response.raise_for_status()
            data = response.json()
            return [ImageInfo(**img) for img in data.get("images", [])]

    async def get_version(self) -> VersionInfo:
        """API: GET /api/v1/version - Get clab and API server version"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.get_version()
        else:
            response = await self.http_client.get("/api/v1/version")
            response.raise_for_status()
            data = response.json()
            return VersionInfo(**data)

    async def deploy_lab(self, topology: TopologySpec) -> RuntimeLabState:
        """API: POST /api/v1/labs - Deploy lab from topology spec"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.deploy_lab(topology)
        else:
            response = await self.http_client.post(
                "/api/v1/labs",
                json=topology.dict()
            )
            response.raise_for_status()
            data = response.json()
            return RuntimeLabState(**data)

    async def list_labs(self) -> List[Dict[str, Any]]:
        """API: GET /api/v1/labs - List all labs"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.list_labs()
        else:
            response = await self.http_client.get("/api/v1/labs")
            response.raise_for_status()
            data = response.json()
            return data.get("labs", [])

    async def inspect_lab(self, lab_id: str) -> Optional[RuntimeLabState]:
        """API: GET /api/v1/labs/{lab_id} - Inspect lab runtime state"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.inspect_lab(lab_id)
        else:
            response = await self.http_client.get(f"/api/v1/labs/{lab_id}")
            if response.status_code == 404:
                return None
            response.raise_for_status()
            data = response.json()
            return RuntimeLabState(**data)

    async def destroy_lab(self, lab_id: str) -> bool:
        """API: DELETE /api/v1/labs/{lab_id} - Destroy lab"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.destroy_lab(lab_id)
        else:
            response = await self.http_client.delete(f"/api/v1/labs/{lab_id}")
            if response.status_code == 404:
                return False
            response.raise_for_status()
            return True

    async def exec_node(
        self,
        lab_id: str,
        node_name: str,
        command: str
    ) -> str:
        """API: POST /api/v1/labs/{lab_id}/nodes/{node_name}/exec - Execute command"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.exec_node(lab_id, node_name, command)
        else:
            response = await self.http_client.post(
                f"/api/v1/labs/{lab_id}/nodes/{node_name}/exec",
                json={"command": command}
            )
            response.raise_for_status()
            data = response.json()
            return data.get("output", "")

    async def save_node_config(self, lab_id: str, node_name: str) -> str:
        """API: POST /api/v1/labs/{lab_id}/nodes/{node_name}/save - Save config"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.save_node_config(lab_id, node_name)
        else:
            response = await self.http_client.post(
                f"/api/v1/labs/{lab_id}/nodes/{node_name}/save"
            )
            response.raise_for_status()
            data = response.json()
            return data.get("message", "")

    async def get_node_logs(
        self,
        lab_id: str,
        node_name: str,
        lines: int = 100
    ) -> str:
        """API: GET /api/v1/labs/{lab_id}/nodes/{node_name}/logs - Get node logs"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.get_node_logs(lab_id, node_name, lines)
        else:
            response = await self.http_client.get(
                f"/api/v1/labs/{lab_id}/nodes/{node_name}/logs",
                params={"lines": lines}
            )
            response.raise_for_status()
            data = response.json()
            return data.get("logs", "")

    async def get_graph(self, lab_id: str) -> Dict[str, Any]:
        """API: GET /api/v1/labs/{lab_id}/graph - Get topology graph (NeXt UI format)"""
        if self.mode == APIMode.MOCK:
            return self.mock_server.get_graph(lab_id)
        else:
            response = await self.http_client.get(f"/api/v1/labs/{lab_id}/graph")
            response.raise_for_status()
            return response.json()

    async def close(self):
        """Clean up HTTP client"""
        await self.http_client.aclose()


# Helper to create client based on environment
def create_api_client(use_mock: bool = True) -> ClabAPIClient:
    """Factory function to create API client"""
    mode = APIMode.MOCK if use_mock else APIMode.REAL
    return ClabAPIClient(mode=mode)
