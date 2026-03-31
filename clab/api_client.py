"""
clab-api-server client wrapper.
Calls the real containerlab API server (clab-api-server).
"""

from typing import Optional, List, Dict, Any
import httpx

from models.topology import (
    TopologySpec, RuntimeLabState, RuntimeNodeInfo, LabState,
    ImageInfo, VersionInfo
)


class ClabAPIClient:
    """
    Client for clab-api-server communication.
    """

    def __init__(
        self,
        base_url: str,
        auth_token: Optional[str] = None
    ):
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.http_client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=self._get_headers(),
            timeout=120.0,
        )

    def _get_headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return headers

    def _refresh_headers(self) -> None:
        self.http_client.headers.update(self._get_headers())

    def set_auth_token(self, token: str) -> None:
        self.auth_token = token
        self._refresh_headers()

    async def authenticate(self, username: str, password: str) -> Dict[str, Any]:
        """POST /login - Obtain JWT token"""
        response = await self.http_client.post(
            "/login",
            json={"username": username, "password": password}
        )
        response.raise_for_status()
        return response.json()

    async def get_images(self) -> List[ImageInfo]:
        """GET /api/v1/images - List available container images"""
        response = await self.http_client.get("/api/v1/images")
        response.raise_for_status()
        data = response.json()
        return [ImageInfo(**img) for img in data.get("images", [])]

    async def get_version(self) -> VersionInfo:
        """GET /api/v1/version - Get containerlab and API server version"""
        response = await self.http_client.get("/api/v1/version")
        response.raise_for_status()
        data = response.json()
        return VersionInfo(**data)

    def _containers_to_runtime_lab(
        self, containers: List[Dict[str, Any]], lab_name: str
    ) -> RuntimeLabState:
        """Map containerlab API container list to RuntimeLabState."""
        nodes = []
        for c in containers:
            mgmt_ip = (c.get("ipv4_address") or "").split("/")[0] or None
            nodes.append(RuntimeNodeInfo(
                name=c.get("name", ""),
                container_id=c.get("container_id", ""),
                state=c.get("state", "unknown"),
                status=c.get("status"),
                image=c.get("image", ""),
                mgmt_ip=mgmt_ip,
            ))
        return RuntimeLabState(
            lab_id=lab_name,
            lab_name=lab_name,
            status=LabState.RUNNING,
            api_source=self.base_url,
            nodes_runtime=nodes,
        )

    async def deploy_lab_from_yaml(
        self, yaml_content: Dict[str, Any]
    ) -> RuntimeLabState:
        """POST /api/v1/labs - Deploy lab by sending raw YAML content as topologyContent."""
        lab_name = str(yaml_content.get("name") or "lab").strip()
        response = await self.http_client.post(
            "/api/v1/labs",
            json={"topologyContent": yaml_content}
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            detail = ""
            content_type = (response.headers.get("content-type") or "").lower()
            if "application/json" in content_type:
                try:
                    parsed = response.json()
                    if isinstance(parsed, dict):
                        detail = str(parsed.get("detail") or parsed.get("error") or parsed)
                    else:
                        detail = str(parsed)
                except Exception:
                    detail = response.text
            else:
                detail = response.text
            detail = (detail or "").strip()
            if detail:
                raise RuntimeError(
                    f"Remote deploy failed ({response.status_code}) at {response.request.url}: {detail}"
                ) from e
            raise RuntimeError(
                f"Remote deploy failed ({response.status_code}) at {response.request.url}"
            ) from e
        data = response.json()
        containers = data if isinstance(data, list) else []
        return self._containers_to_runtime_lab(containers, lab_name)

    async def list_labs(self) -> List[Dict[str, Any]]:
        """GET /api/v1/labs - List all running labs"""
        response = await self.http_client.get("/api/v1/labs")
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []

    async def inspect_lab(self, lab_name: str) -> Optional[RuntimeLabState]:
        """GET /api/v1/labs/{labName} - Inspect a specific lab"""
        response = await self.http_client.get(f"/api/v1/labs/{lab_name}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        data = response.json()
        containers = data if isinstance(data, list) else []
        return self._containers_to_runtime_lab(containers, lab_name)

    async def destroy_lab(self, lab_name: str, cleanup: bool = False) -> bool:
        """DELETE /api/v1/labs/{labName} - Destroy a lab."""
        params = {"cleanup": "true"} if cleanup else {}
        response = await self.http_client.delete(f"/api/v1/labs/{lab_name}", params=params)
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return True

    async def exec_node(
        self,
        lab_name: str,
        node_filter: str,
        command: str
    ) -> str:
        """POST /api/v1/labs/{labName}/exec - Execute command on lab nodes"""
        response = await self.http_client.post(
            f"/api/v1/labs/{lab_name}/exec",
            params={"nodeFilter": node_filter} if node_filter else {},
            json={"command": command}
        )
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list):
            return "\n".join(
                f"[{r.get('name', '')}] {r.get('stdout', '')}{r.get('stderr', '')}"
                for r in data
            )
        return str(data)

    async def save_node_config(self, lab_name: str, node_filter: str = "") -> str:
        """POST /api/v1/labs/{labName}/save - Save node configurations"""
        response = await self.http_client.post(
            f"/api/v1/labs/{lab_name}/save",
            params={"nodeFilter": node_filter} if node_filter else {},
        )
        response.raise_for_status()
        data = response.json()
        return data.get("message", "")

    async def get_node_logs(
        self,
        lab_name: str,
        node_name: str,
        tail: int = 100
    ) -> str:
        """GET /api/v1/labs/{labName}/nodes/{nodeName}/logs - Get node logs"""
        response = await self.http_client.get(
            f"/api/v1/labs/{lab_name}/nodes/{node_name}/logs",
            params={"tail": tail}
        )
        response.raise_for_status()
        data = response.json()
        return data.get("logs", "")

    async def request_node_ssh_access(
        self,
        lab_name: str,
        node_name: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/labs/{labName}/nodes/{nodeName}/ssh - Request temporary SSH access."""
        body = payload if isinstance(payload, dict) else {}
        response = await self.http_client.post(
            f"/api/v1/labs/{lab_name}/nodes/{node_name}/ssh",
            json=body,
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {"raw": data}

    async def close(self):
        """Clean up HTTP client"""
        await self.http_client.aclose()


def create_api_client(
    base_url: str,
    auth_token: Optional[str] = None
) -> ClabAPIClient:
    """Factory function to create the API client."""
    return ClabAPIClient(base_url=base_url, auth_token=auth_token)
