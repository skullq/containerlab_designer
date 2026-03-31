"""
clab-api-server client wrapper.
Calls the real containerlab API server (clab-api-server).
"""

from typing import Optional, List, Dict, Any
import httpx
import re

from models.topology import (
    TopologySpec, RuntimeLabState, RuntimeNodeInfo, LabState,
    ImageInfo, VersionInfo
)


class RemoteAPIError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = int(status_code)
        self.detail = str(detail or "").strip()
        super().__init__(self.detail or f"Remote API request failed ({self.status_code})")


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

    @staticmethod
    def _to_positive_int(value: Any) -> Optional[int]:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None

        # Handle inspect variants like "0.0.0.0:49158" or "49158/tcp".
        if ":" in text:
            text = text.rsplit(":", 1)[-1].strip()
        match = re.search(r"(\d+)", text)
        if match:
            text = match.group(1)

        try:
            parsed = int(text)
            return parsed if parsed > 0 else None
        except Exception:
            return None

    def _extract_ssh_port(self, container: Dict[str, Any]) -> Optional[int]:
        """Extract SSH host port from inspect payload with flexible schema handling."""
        direct_candidates = [
            container.get("ssh_port"),
            container.get("sshPort"),
            container.get("host_ssh_port"),
            container.get("hostSshPort"),
        ]
        for candidate in direct_candidates:
            parsed = self._to_positive_int(candidate)
            if parsed:
                return parsed

        def _extract_from_dict(mapping: Dict[str, Any]) -> Optional[int]:
            for key in ("22/tcp", "tcp/22", "ssh", "SSH"):
                if key not in mapping:
                    continue
                value = mapping.get(key)
                parsed = self._to_positive_int(value)
                if parsed:
                    return parsed
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, dict):
                            for field in ("HostPort", "host_port", "public_port", "PublicPort", "port"):
                                parsed_item = self._to_positive_int(item.get(field))
                                if parsed_item:
                                    return parsed_item
                elif isinstance(value, dict):
                    for field in ("HostPort", "host_port", "public_port", "PublicPort", "port"):
                        parsed_item = self._to_positive_int(value.get(field))
                        if parsed_item:
                            return parsed_item
            return None

        for key in ("ports", "port_bindings", "portBindings"):
            value = container.get(key)
            if isinstance(value, dict):
                parsed = _extract_from_dict(value)
                if parsed:
                    return parsed
            elif isinstance(value, list):
                for item in value:
                    if not isinstance(item, dict):
                        continue
                    private_port = item.get("private_port")
                    if self._to_positive_int(private_port) == 22:
                        for field in ("public_port", "PublicPort", "host_port", "HostPort"):
                            parsed = self._to_positive_int(item.get(field))
                            if parsed:
                                return parsed

        return None

    @staticmethod
    def _node_name_candidates(lab_name: str, node_name: str) -> List[str]:
        raw_lab = str(lab_name or "").strip()
        raw_node = str(node_name or "").strip()
        if not raw_node:
            return []
        prefix = f"clab-{raw_lab}-" if raw_lab else ""
        candidates = {raw_node}
        if prefix and raw_node.startswith(prefix):
            candidates.add(raw_node[len(prefix):])
        elif prefix:
            candidates.add(f"{prefix}{raw_node}")
        return [c for c in candidates if c]

    def _extract_ssh_session_port(self, session: Dict[str, Any]) -> Optional[int]:
        fields = [
            "ssh_port", "sshPort", "port", "host_port", "hostPort",
            "published_port", "publishedPort", "local_port", "localPort",
        ]
        for field in fields:
            parsed = self._to_positive_int(session.get(field))
            if parsed:
                return parsed
        return None

    def _extract_ssh_session_node_name(self, session: Dict[str, Any]) -> str:
        fields = ["node_name", "nodeName", "node", "container_name", "containerName", "name"]
        for field in fields:
            value = str(session.get(field) or "").strip()
            if value:
                return value
        return ""

    async def _get_ssh_session_port_index(self, lab_name: str) -> Dict[str, int]:
        """Get node->ssh_port map from /api/v1/ssh/sessions when available."""
        response = await self.http_client.get("/api/v1/ssh/sessions")
        if response.status_code in (404, 405):
            return {}
        response.raise_for_status()
        payload = response.json()

        sessions: List[Dict[str, Any]] = []
        if isinstance(payload, list):
            sessions = [item for item in payload if isinstance(item, dict)]
        elif isinstance(payload, dict):
            for key in ("sessions", "data", "items", "results"):
                value = payload.get(key)
                if isinstance(value, list):
                    sessions = [item for item in value if isinstance(item, dict)]
                    break

        index: Dict[str, int] = {}
        for session in sessions:
            session_lab = str(
                session.get("lab")
                or session.get("lab_name")
                or session.get("labName")
                or ""
            ).strip()
            if session_lab and session_lab != str(lab_name or "").strip():
                continue

            node_name = self._extract_ssh_session_node_name(session)
            port = self._extract_ssh_session_port(session)
            if not node_name or not port:
                continue

            for key in self._node_name_candidates(lab_name, node_name):
                index[key] = port

        return index

    async def _enrich_runtime_with_ssh_sessions(self, runtime: RuntimeLabState) -> RuntimeLabState:
        try:
            port_index = await self._get_ssh_session_port_index(runtime.lab_name)
        except Exception:
            # SSH session endpoint may be unavailable depending on server version.
            return runtime

        if not port_index:
            return runtime

        for node in runtime.nodes_runtime:
            matched_port = None
            for key in self._node_name_candidates(runtime.lab_name, node.name):
                if key in port_index:
                    matched_port = port_index[key]
                    break
            if matched_port:
                node.ssh_port = matched_port
                node.ssh_reachable = True
        return runtime

    def set_auth_token(self, token: str) -> None:
        self.auth_token = token
        self._refresh_headers()

    def _extract_error_detail(self, response: httpx.Response) -> str:
        content_type = (response.headers.get("content-type") or "").lower()
        if "application/json" in content_type:
            try:
                parsed = response.json()
                if isinstance(parsed, dict):
                    return str(parsed.get("detail") or parsed.get("error") or parsed).strip()
                return str(parsed).strip()
            except Exception:
                pass
        return str(response.text or "").strip()

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
            ssh_port = self._extract_ssh_port(c)
            nodes.append(RuntimeNodeInfo(
                name=c.get("name", ""),
                container_id=c.get("container_id", ""),
                state=c.get("state", "unknown"),
                status=c.get("status"),
                image=c.get("image", ""),
                mgmt_ip=mgmt_ip,
                ssh_port=ssh_port,
                ssh_reachable=bool(ssh_port or mgmt_ip),
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
        runtime = self._containers_to_runtime_lab(containers, lab_name)
        runtime = await self._enrich_runtime_with_ssh_sessions(runtime)
        return runtime

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
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            detail = self._extract_error_detail(response)
            if not detail:
                detail = f"Remote SSH access request failed ({response.status_code}) at {response.request.url}"
            raise RemoteAPIError(response.status_code, detail) from e
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
