"""Dev seed script — creates demo org, users, and project."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import uuid
import bcrypt
from apps.api.models.user import User, UserStatus
from apps.api.models.organization import Organization, OrgMember, OrgRole
from apps.api.models.project import Project, ProjectMember, ProjectType, ProjectRole
from apps.api.database import SessionLocal

def seed():
    db = SessionLocal()
    try:
        # Create org
        org = Organization(name="Demo Org", slug="demo-org")
        db.add(org)
        db.flush()

        # Create users
        pwd_bytes = "password123".encode('utf-8')
        salt = bcrypt.gensalt()
        pw_hash = bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')
        
        users = []
        for i in range(1, 4):
            user = User(
                email=f"user{i}@example.com",
                name=f"Demo User {i}",
                password_hash=pw_hash,
                status=UserStatus.active
            )
            users.append(user)
            db.add(user)
        db.flush()

        # Create admin user
        admin = User(
            email="admin@demo.com",
            name="Admin User",
            password_hash=pw_hash,
            status=UserStatus.active,
        )
        db.add(admin)
        db.flush()

        # Add admin to org
        member = OrgMember(org_id=org.id, user_id=admin.id, role=OrgRole.owner)
        db.add(member)

        # Create demo project
        project = Project(
            org_id=org.id,
            name="Demo Project",
            project_type=ProjectType.personal,
            created_by=admin.id,
        )
        db.add(project)
        db.flush()

        # Add admin as project owner
        pm = ProjectMember(project_id=project.id, user_id=admin.id, role=ProjectRole.owner)
        db.add(pm)

        db.commit()
        print(f"Seeded: org={org.id}, admin={admin.id}, project={project.id}")
    finally:
        db.close()

if __name__ == "__main__":
    seed()
