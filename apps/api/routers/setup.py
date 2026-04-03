"""
First-time setup / onboarding endpoints.
These are only available when no superadmin exists in the system.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr

from ..database import get_db
from ..models.user import User, UserStatus
from ..services.auth_service import hash_password, create_access_token, create_refresh_token
from ..schemas.auth import TokenResponse
from ..middleware.rate_limit import rate_limit

router = APIRouter(prefix="/setup", tags=["setup"])


class SetupStatusResponse(BaseModel):
    needs_setup: bool
    message: str


class CreateSuperAdminRequest(BaseModel):
    email: EmailStr
    name: str
    password: str


class SetupCompleteResponse(BaseModel):
    message: str
    user_id: str
    access_token: str
    refresh_token: str


def _has_superadmin(db: Session) -> bool:
    """Check if any superadmin exists in the system."""
    return db.query(User).filter(
        User.is_superadmin == True,
        User.deleted_at.is_(None),
    ).first() is not None


@router.get("/status", response_model=SetupStatusResponse)
def get_setup_status(db: Session = Depends(get_db)):
    """
    Check if the system needs initial setup.
    Returns needs_setup=True if no superadmin exists.
    """
    if _has_superadmin(db):
        return SetupStatusResponse(
            needs_setup=False,
            message="System is already configured",
        )
    return SetupStatusResponse(
        needs_setup=True,
        message="No superadmin found. Please complete initial setup.",
    )


@router.post("/create-superadmin", response_model=SetupCompleteResponse, status_code=status.HTTP_201_CREATED, dependencies=[Depends(rate_limit("create_superadmin", 3, 600))])
def create_superadmin(body: CreateSuperAdminRequest, db: Session = Depends(get_db)):
    """
    Create the first superadmin user.
    This endpoint is only available when no superadmin exists.
    """
    # Check if superadmin already exists
    if _has_superadmin(db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Setup already completed. Superadmin already exists.",
        )
    
    # Check if email is already taken
    existing = db.query(User).filter(User.email == body.email, User.deleted_at.is_(None)).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )
    
    # Create superadmin user
    user = User(
        email=body.email,
        name=body.name,
        password_hash=hash_password(body.password),
        status=UserStatus.active,
        is_superadmin=True,
        email_verified=True,  # Skip verification for initial setup
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Generate tokens
    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))
    
    return SetupCompleteResponse(
        message="Superadmin created successfully. You can now create organizations.",
        user_id=str(user.id),
        access_token=access_token,
        refresh_token=refresh_token,
    )
