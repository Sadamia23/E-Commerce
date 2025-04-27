using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Infrastructure.Config;

public class RoleConfiguration : IEntityTypeConfiguration<IdentityRole>
{
    public void Configure(EntityTypeBuilder<IdentityRole> builder)
    {
        builder.HasData(
            new IdentityRole{ Id = "a4c9094b-2c7f-44c7-9a67-9e714aacac48", Name = "Admin", NormalizedName = "ADMIN" },
            new IdentityRole{ Id = "b839f360-2211-4201-b24c-9d95ad8c9c13", Name = "Customer", NormalizedName = "CUSTOMER" }
        );
    }
}
