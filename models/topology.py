"""
Topology data models for containerlab integration.
Based on plan.md architecture - TopologySpec, Node, Link, RuntimeLabState.
"""

from typing import Optional, List, Dict, Any
from enum import Enum
from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime, timezone


class DeviceRole(str, Enum):
    """Device role hierarchy for topology layout"""
    UNDEFINED = "undefined"
    OUTSIDE = "outside"
    EDGE_SWITCH = "edge-switch"
    EDGE_ROUTER = "edge-router"
    CORE_ROUTER = "core-router"
    CORE_SWITCH = "core-switch"
    DISTRIBUTION_ROUTER = "distribution-router"
    DISTRIBUTION_SWITCH = "distribution-switch"
    LEAF = "leaf"
    SPINE = "spine"
    ACCESS_SWITCH = "access-switch"


class LinkType(str, Enum):
    """Link connection type"""
    P2P = "p2p"
    TRUNK = "trunk"
    ACCESS = "access"


class LinkState(str, Enum):
    """Link deployment state"""
    PLANNED = "planned"
    DEPLOYED = "deployed"
    FAILED = "failed"


class LabState(str, Enum):
    """Lab deployment state"""
    PLANNED = "planned"
    DEPLOYING = "deploying"
    RUNNING = "running"
    FAILED = "failed"
    DESTROYED = "destroyed"


class Interface(BaseModel):
    """Device interface model"""
    name: str
    is_mgmt: bool = False
    speed: Optional[str] = "1Gbps"
    used: bool = False
    linked_to: Optional[str] = None  # format: "node_name:interface_name"


class MgmtNetwork(BaseModel):
    """Management network configuration"""
    name: str = "clab-mgmt"
    ipv4_subnet: str = "172.20.20.0/24"
    ipv4_gateway: Optional[str] = "172.20.20.1"


class MgmtInfo(BaseModel):
    """Device management info (populate after deployment)"""
    ipv4: Optional[str] = None
    ssh_port: Optional[int] = None
    username: Optional[str] = "admin"
    password: Optional[str] = None
    container_id: Optional[str] = None


class Node(BaseModel):
    """Topology node model - represents a network device"""
    id: str
    name: str
    role: DeviceRole = DeviceRole.UNDEFINED
    kind: str  # containerlab kind: e.g., "nokia_srlinux", "vr-xrv", "linux"
    image: str  # Docker image
    interfaces: List[Interface] = Field(default_factory=list)
    mgmt: Optional[MgmtInfo] = Field(default_factory=MgmtInfo)
    startup_config: Optional[str] = None
    labels: Dict[str, str] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    model_config = ConfigDict(use_enum_values=False)


class Link(BaseModel):
    """Topology link model - represents connection between two nodes"""
    id: str
    a_node: str  # source node id
    a_if: str  # source interface name
    b_node: str  # target node id
    b_if: str  # target interface name
    link_type: LinkType = LinkType.P2P
    state: LinkState = LinkState.PLANNED
    is_mgmt_excluded: bool = True

    model_config = ConfigDict(use_enum_values=False)


class TopologySpec(BaseModel):
    """Complete topology specification - single source of truth"""
    lab_name: str
    lab_id: Optional[str] = None
    mgmt_network: MgmtNetwork = Field(default_factory=MgmtNetwork)
    nodes: List[Node] = Field(default_factory=list)
    links: List[Link] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    model_config = ConfigDict(use_enum_values=False)


class RuntimeNodeInfo(BaseModel):
    """Runtime info for deployed node - from Inspect API"""
    name: str
    container_id: str
    state: str  # running, stopped, failed
    image: str
    mgmt_ip: Optional[str] = None
    ssh_port: Optional[int] = None
    ssh_reachable: Optional[bool] = None
    logs: Optional[str] = None


class RuntimeLabState(BaseModel):
    """Runtime state of deployed lab - merged from Inspect API results"""
    lab_id: str
    lab_name: str
    status: LabState = LabState.PLANNED
    api_source: str  # clab-api-server endpoint
    nodes_runtime: List[RuntimeNodeInfo] = Field(default_factory=list)
    graph_data: Optional[Dict[str, Any]] = None  # Graph API result cache
    last_sync_at: Optional[datetime] = None
    deployed_at: Optional[datetime] = None

    model_config = ConfigDict(use_enum_values=False)


class AuthContext(BaseModel):
    """Authentication context"""
    access_token: str
    refresh_token: Optional[str] = None
    user: str
    roles: List[str] = Field(default_factory=list)
    expires_at: Optional[datetime] = None


class ImageInfo(BaseModel):
    """Container image info from Image List API"""
    repository: str
    tag: str
    image_id: str
    size: str
    created: str
    kind: Optional[str] = None  # inferred kind for containerlab


class VersionInfo(BaseModel):
    """Version info from clab-api-server"""
    containerlab_version: str
    api_server_version: str
    capabilities: List[str] = Field(default_factory=list)
