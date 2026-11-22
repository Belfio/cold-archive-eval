from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    bucket: str = "example-cold-archive"
    region: str = "eu-west-2"
    profile: str = "personal"
